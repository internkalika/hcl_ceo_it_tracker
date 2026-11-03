import { put, get, list, del } from "@vercel/blob";
import { assertOwnPath, blobToken, currentPath, historyPath, historyPrefix } from "./config.js";

/**
 * All Blob access goes through here. Every SDK call:
 *  - passes `token` EXPLICITLY from IT_TRACKER_READ_WRITE_TOKEN (the SDK's BLOB_READ_WRITE_TOKEN fallback is never relied on)
 *  - uses access: "private"
 *  - is restricted to this deployment environment's own path prefix
 */

async function readText(stream) {
  return new Response(stream).text();
}

/** Read a private JSON blob straight from origin storage (no CDN cache). Returns null if it does not exist. */
export async function readJson(pathname) {
  const res = await get(assertOwnPath(pathname), { access: "private", token: blobToken(), useCache: false });
  if (!res || res.statusCode !== 200 || !res.stream) return null;
  const text = await readText(res.stream);
  return { value: JSON.parse(text), etag: res.blob.etag, uploadedAt: res.blob.uploadedAt };
}

/** Write a private JSON blob. `ifMatch` makes the write conditional (optimistic concurrency). */
export async function writeJson(pathname, value, { overwrite = false, ifMatch } = {}) {
  const options = {
    access: "private",
    token: blobToken(),
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: overwrite,
    cacheControlMaxAge: 60,
  };
  if (ifMatch) options.ifMatch = ifMatch;
  return put(assertOwnPath(pathname), JSON.stringify(value), options);
}

export const readCurrent = () => readJson(currentPath());
export const readHistory = (version) => readJson(historyPath(version));

/** List history entries for this environment, newest first. */
export async function listHistory(limit) {
  const out = [];
  let cursor;
  do {
    const page = await list({ token: blobToken(), prefix: assertOwnPath(historyPrefix()), cursor, limit: 1000 });
    for (const b of page.blobs) out.push({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  // Version ids start with a UTC timestamp, so a reverse lexicographic sort is newest first.
  out.sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
  return out.slice(0, limit);
}

/** Best-effort removal of a blob this environment wrote (used to undo an unused history entry). */
export async function removeBlob(pathname) {
  await del(assertOwnPath(pathname), { token: blobToken() });
}
