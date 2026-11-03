/**
 * Local stand-in for the Vercel platform: serves index.html with the headers from vercel.json and routes /api/* to the
 * real handler files. Uses the strict fake Blob (see register.mjs). Used by both the API and the browser tests.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SECRETS = {
  publish: "correct-horse-battery-staple",
  session: "s3ssion-s1gning-secret-0123456789abcdefghijklmnop",
  decoy: "vercel_blob_rw_decoystore_DECOYDECOYDECOYDECOY",
};

export function setEnv(vercelEnv = "preview") {
  process.env.VERCEL_ENV = vercelEnv;
  process.env.IT_TRACKER_STORE_ID = "store_teststore123";
  process.env.IT_TRACKER_READ_WRITE_TOKEN = "vercel_blob_rw_teststore123_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  process.env.IT_TRACKER_PUBLISH_SECRET = SECRETS.publish;
  process.env.IT_TRACKER_SESSION_SECRET = SECRETS.session;
  process.env.IT_TRACKER_WEBHOOK_PUBLIC_KEY = "webhook-public-key-not-used";
  delete process.env.BLOB_READ_WRITE_TOKEN; // must never be needed
}

const vercelJson = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8"));
const staticHeaders = Object.fromEntries(vercelJson.headers[0].headers.map((h) => [h.key, h.value]));

export async function startServer() {
  const handlers = {
    data: (await import("../api/data.js")).default,
    auth: (await import("../api/auth.js")).default,
    publish: (await import("../api/publish.js")).default,
  };
  const log = []; // every API response (status, headers, body) for secret scanning
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const m = /^\/api\/(data|auth|publish)$/.exec(url.pathname);
    if (m) {
      const chunks = [];
      const origWrite = res.end.bind(res);
      res.end = (chunk, ...a) => { if (chunk) chunks.push(Buffer.from(chunk)); log.push({ url: req.url, status: res.statusCode, headers: res.getHeaders(), body: Buffer.concat(chunks).toString() }); return origWrite(chunk, ...a); };
      return handlers[m[1]](req, res);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...staticHeaders });
      return res.end(readFileSync(path.join(root, "index.html")));
    }
    res.writeHead(404); res.end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, log, close: () => new Promise((r) => server.close(r)) };
}
