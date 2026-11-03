/**
 * In-memory stand-in for @vercel/blob, used ONLY by the tests (wired in through test/register.mjs).
 * It is deliberately strict: a call is rejected unless it passes the explicit custom token and access: "private",
 * so the tests prove the code never relies on BLOB_READ_WRITE_TOKEN or on public access.
 */
export const TEST_TOKEN = "vercel_blob_rw_teststore123_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
export const store = new Map(); // pathname -> { body, etag, uploadedAt, contentType }
export const calls = []; //        every SDK call, for assertions
let n = 0;

class BlobError extends Error { constructor(m, name) { super(m); this.name = name || "BlobError"; } }

function check(op, pathname, opts) {
  calls.push({ op, pathname, access: opts?.access, tokenOk: opts?.token === TEST_TOKEN });
  if (opts?.token !== TEST_TOKEN) throw new BlobError("No token found or token is not the expected custom token", "BlobAccessError");
  if (op !== "del" && op !== "list" && opts.access !== "private") throw new BlobError("access must be private", "BlobError");
}

export async function put(pathname, body, opts) {
  check("put", pathname, opts);
  const existing = store.get(pathname);
  if (existing && !opts.allowOverwrite) throw new BlobError("This blob already exists", "BlobError");
  if (opts.ifMatch && (!existing || existing.etag !== opts.ifMatch)) throw new BlobError("Precondition failed", "BlobPreconditionFailedError");
  const etag = `"e${++n}"`;
  store.set(pathname, { body: String(body), etag, uploadedAt: new Date(), contentType: opts.contentType });
  return { pathname, url: `https://x.private.blob.vercel-storage.com/${pathname}`, etag };
}

export async function get(pathname, opts) {
  check("get", pathname, opts);
  const e = store.get(pathname);
  if (!e) return null;
  return {
    statusCode: 200,
    stream: new Response(e.body).body,
    headers: new Headers(),
    blob: { pathname, etag: e.etag, size: e.body.length, contentType: e.contentType, uploadedAt: e.uploadedAt },
  };
}

export async function list(opts) {
  check("list", opts.prefix, opts);
  const blobs = [...store.entries()]
    .filter(([p]) => p.startsWith(opts.prefix || ""))
    .map(([pathname, e]) => ({ pathname, url: "", size: e.body.length, uploadedAt: e.uploadedAt, etag: e.etag }));
  return { blobs, hasMore: false };
}

export async function del(pathname, opts) {
  check("del", pathname, opts);
  store.delete(pathname);
}

export const reset = () => { store.clear(); calls.length = 0; };
