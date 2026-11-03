import { readCurrent } from "../lib/store.js";
import { validateEnvelope } from "../lib/validate.js";
import { NO_STORE, sendError, sendJson } from "../lib/http.js";

/**
 * PUBLIC, read-only. Returns the latest published dashboard data for THIS deployment environment.
 * The Blob store is private: the browser never talks to Blob, only to this function, which reads with the
 * server-side token. No credential, token, path or store detail is ever included in the response.
 *
 * Caching: browsers must revalidate on every load (ETag -> cheap 304); Vercel's edge may hold a response for at most
 * 10 seconds. So a publish reaches every viewer within ~10s of their next page load, with no redeploy.
 */
const CACHE = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "Vercel-CDN-Cache-Control": "max-age=10",
};

export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD", ...NO_STORE });
    }
    const current = await readCurrent();
    if (!current) return sendJson(res, 404, { error: "no_published_data" }, NO_STORE);

    const envelope = validateEnvelope(current.value); // never serve something the dashboard cannot trust
    const etag = `"${envelope.version}"`;
    const headers = { ...CACHE, ETag: etag };

    const inm = String(req.headers["if-none-match"] || "");
    if (inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
      res.statusCode = 304;
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      return res.end();
    }
    if (req.method === "HEAD") {
      res.statusCode = 200;
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      return res.end();
    }
    return sendJson(res, 200, {
      schemaVersion: 1,
      version: envelope.version,
      publishedAt: envelope.publishedAt,
      source: envelope.source,
    }, headers);
  } catch (err) {
    return sendError(res, err, "data");
  }
}
