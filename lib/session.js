import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { authSecrets, deploymentEnv, LIMITS } from "./config.js";
import { HttpError, parseCookies } from "./http.js";

export const COOKIE_NAME = "it_tracker_session";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// Separate keys per purpose, derived from the session secret.
const sigKey = (secret) => hmac(secret, "it-tracker/session-signature/v1");
const csrfKey = (secret) => hmac(secret, "it-tracker/csrf-token/v1");
const passKey = (secret) => hmac(secret, "it-tracker/passphrase-compare/v1");

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Constant-time passphrase check (both sides are HMACed, so length is not leaked). */
export function passphraseMatches(input) {
  const { publishSecret, sessionSecret } = authSecrets();
  const k = passKey(sessionSecret);
  return timingSafeEqual(hmac(k, String(input)), hmac(k, publishSecret));
}

export function createSession(now = Date.now()) {
  const { sessionSecret } = authSecrets();
  const payload = {
    sid: randomBytes(16).toString("hex"),
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + LIMITS.sessionSeconds,
    env: deploymentEnv(),
  };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(hmac(sigKey(sessionSecret), body));
  return { token: `v1.${body}.${sig}`, payload };
}

/** Returns the verified payload, or null. Never throws on bad input. */
export function verifySessionToken(token, now = Date.now()) {
  try {
    const { sessionSecret } = authSecrets();
    const [v, body, sig, extra] = String(token || "").split(".");
    if (v !== "v1" || !body || !sig || extra !== undefined) return null;
    if (!safeEqual(sig, b64u(hmac(sigKey(sessionSecret), body)))) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const t = Math.floor(now / 1000);
    if (!p || typeof p.sid !== "string" || p.env !== deploymentEnv()) return null;
    if (!Number.isInteger(p.exp) || !Number.isInteger(p.iat) || p.exp <= t || p.iat > t + 60) return null;
    if (p.exp - p.iat > LIMITS.sessionSeconds) return null;
    return p;
  } catch {
    return null;
  }
}

export function sessionFromRequest(req) {
  return verifySessionToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

export const csrfTokenFor = (payload) => b64u(hmac(csrfKey(authSecrets().sessionSecret), payload.sid));

/** CSRF layer 2: a per-session token that must be echoed in a custom header. */
export function assertCsrf(req, payload) {
  const sent = req.headers["x-csrf-token"];
  if (!sent || typeof sent !== "string" || !safeEqual(sent, csrfTokenFor(payload))) {
    throw new HttpError(403, "bad_csrf", "Security token missing or invalid. Sign in again.");
  }
}

export function requireSession(req) {
  const p = sessionFromRequest(req);
  if (!p) throw new HttpError(401, "unauthenticated", "Sign in to publish.");
  return p;
}

const base = "HttpOnly; Secure; SameSite=Strict; Path=/api";
export const sessionCookie = (token) => `${COOKIE_NAME}=${token}; Max-Age=${LIMITS.sessionSeconds}; ${base}`;
export const clearCookie = () => `${COOKIE_NAME}=; Max-Age=0; ${base}`;

export const ipKey = (ip) => createHash("sha256").update(`ip:${ip}`).digest("hex").slice(0, 32);
