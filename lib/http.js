import { createHash } from "node:crypto";

export class HttpError extends Error {
  constructor(status, code, message, headers) {
    super(message || code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers || {};
  }
}

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(text);
}

/** Never-cacheable response (used by every authenticated / write endpoint). */
export const NO_STORE = { "Cache-Control": "no-store" };

const first = (v) => String(Array.isArray(v) ? v[0] : v || "").split(",")[0].trim();
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * CSRF layer 1: state-changing requests must come from this site itself.
 * Origin must exactly equal the origin the request was addressed to; Sec-Fetch-Site (when sent) must be same-origin.
 */
export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  const host = first(req.headers["x-forwarded-host"]) || first(req.headers.host);
  if (!origin || !host) throw new HttpError(403, "bad_origin", "Request origin could not be verified.");
  const proto = first(req.headers["x-forwarded-proto"]) || (LOCAL.test(host) ? "http" : "https");
  if (origin !== `${proto}://${host}`) throw new HttpError(403, "bad_origin", "Request origin is not allowed.");
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin") throw new HttpError(403, "bad_origin", "Cross-site requests are not allowed.");
}

export function assertJsonRequest(req) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (!ct.startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Send application/json.");
}

/** Read a JSON body without ever touching req.body, enforcing a hard byte cap while streaming. */
export async function readJsonBody(req, maxBytes) {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "payload_too_large", "Request body is too large.", { Connection: "close" });
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      // Stop reading (nothing more is buffered) and answer; Connection: close makes the server drop the rest.
      throw new HttpError(413, "payload_too_large", "Request body is too large.", { Connection: "close" });
    }
    chunks.push(chunk);
  }
  if (total === 0) throw new HttpError(400, "empty_body", "Request body is empty.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Client address as set by Vercel's edge (it overwrites these headers, so they cannot be spoofed by the caller). */
export function clientIp(req) {
  return first(req.headers["x-vercel-forwarded-for"]) || first(req.headers["x-real-ip"]) || first(req.headers["x-forwarded-for"]) || req.socket?.remoteAddress || "unknown";
}

export const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

/** Log only a stable code, never request bodies, headers, cookies or secrets. */
export function logError(where, err) {
  const code = err?.code || err?.name || "error";
  console.error(`[it-tracker] ${where}: ${code}`);
}

/** Convert any thrown error to a safe response. Internal detail is never returned to the client. */
export function sendError(res, err, where) {
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { error: err.code, message: err.message }, { ...NO_STORE, ...err.headers });
  }
  logError(where, err);
  if (err?.name === "ConfigError") {
    return sendJson(res, 503, { error: "not_configured", message: "This feature is not configured on this deployment." }, NO_STORE);
  }
  return sendJson(res, 500, { error: "server_error", message: "Something went wrong. Please try again." }, NO_STORE);
}
