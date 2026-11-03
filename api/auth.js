import { authSecrets } from "../lib/config.js";
import { HttpError, NO_STORE, assertJsonRequest, assertSameOrigin, clientIp, readJsonBody, sendError, sendJson } from "../lib/http.js";
import { clearCookie, createSession, csrfTokenFor, ipKey, passphraseMatches, sessionCookie, sessionFromRequest } from "../lib/session.js";
import { assertNotLocked, recordFailure, recordSuccess } from "../lib/ratelimit.js";

/**
 * GET    session status (and the per-session CSRF token when signed in)
 * POST   sign in with the shared passphrase  { passphrase }
 * DELETE sign out
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (payload) => ({
  authenticated: true,
  csrfToken: csrfTokenFor(payload),
  expiresAt: new Date(payload.exp * 1000).toISOString(),
});

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      authSecrets(); // surfaces "not configured" instead of a misleading "signed out"
      const p = sessionFromRequest(req);
      return sendJson(res, 200, p ? status(p) : { authenticated: false }, NO_STORE);
    }

    if (req.method === "DELETE") {
      assertSameOrigin(req);
      return sendJson(res, 200, { authenticated: false }, { ...NO_STORE, "Set-Cookie": clearCookie() });
    }

    if (req.method === "POST") {
      assertSameOrigin(req);
      assertJsonRequest(req);
      authSecrets();
      const body = await readJsonBody(req, 4 * 1024);
      const pass = body && typeof body === "object" ? body.passphrase : undefined;
      if (typeof pass !== "string" || pass.length === 0 || pass.length > 256) {
        throw new HttpError(400, "bad_request", "Enter the publishing passphrase.");
      }

      const ip = ipKey(clientIp(req));
      await assertNotLocked(ip); // locked clients cannot test guesses at all

      if (!passphraseMatches(pass)) {
        await recordFailure(ip);
        await sleep(400); // uniform small delay on every failure
        throw new HttpError(401, "invalid_credentials", "That passphrase is not correct.");
      }

      await recordSuccess(ip);
      const { token, payload } = createSession();
      return sendJson(res, 200, status(payload), { ...NO_STORE, "Set-Cookie": sessionCookie(token) });
    }

    return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, POST, DELETE", ...NO_STORE });
  } catch (err) {
    return sendError(res, err, "auth");
  }
}
