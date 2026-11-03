import { randomBytes } from "node:crypto";
import { LIMITS, currentPath, historyPath } from "../lib/config.js";
import { HttpError, NO_STORE, assertJsonRequest, assertSameOrigin, readJsonBody, sendError, sendJson } from "../lib/http.js";
import { assertCsrf, requireSession } from "../lib/session.js";
import { listHistory, readCurrent, readHistory, removeBlob, writeJson } from "../lib/store.js";
import { validateEnvelope, validateSource, validateVersionId } from "../lib/validate.js";

/**
 * AUTHENTICATED publishing (session cookie + same-origin + CSRF token required for every write).
 *
 * GET   current version and recent history (for the rollback list)
 * POST  { action: "publish",  source, baseVersion? }   publish a parsed workbook
 * POST  { action: "rollback", version, baseVersion? }  re-publish an earlier version (itself recorded, so reversible)
 *
 * Every publish writes an immutable history entry FIRST, then replaces current.json with an ETag-conditional write,
 * so two people publishing at once cannot silently overwrite each other.
 */

const newVersion = (now = new Date()) =>
  `${now.toISOString().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`; // e.g. 20261103T140512123Z-1a2b3c4d (ms resolution keeps history ordered)

const summary = (e) => ({
  version: e.version,
  publishedAt: e.publishedAt,
  action: e.action || "publish",
  rollbackOf: e.rollbackOf || null,
  fileName: e.source.fileName,
  projectCount: e.source.projects.length,
});

async function commit(envelope, current, baseVersion) {
  const currentVersion = current ? current.value?.version : null;
  if (baseVersion !== undefined && baseVersion !== currentVersion) {
    throw new HttpError(409, "conflict", "The published data changed since you loaded this page. Reload to see it, or publish anyway.");
  }
  const hist = historyPath(envelope.version);
  await writeJson(hist, envelope, { overwrite: false }); // immutable history entry first
  try {
    await writeJson(
      currentPath(),
      envelope,
      current ? { overwrite: true, ifMatch: current.etag } : { overwrite: false },
    );
  } catch (err) {
    await removeBlob(hist).catch(() => {}); // do not leave a version that was never live
    if (err?.name === "BlobPreconditionFailedError" || /precondition|already exists/i.test(String(err?.message))) {
      throw new HttpError(409, "conflict", "Someone else published at the same moment. Reload and try again.");
    }
    throw err;
  }
  return summary(envelope);
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      requireSession(req);
      const current = await readCurrent();
      const entries = await listHistory(LIMITS.historyListLimit);
      const history = [];
      await Promise.all(entries.map(async (e, i) => {
        try {
          const version = e.pathname.split("/").pop().replace(/\.json$/, "");
          validateVersionId(version);
          const r = await readHistory(version);
          if (r) history[i] = summary(validateEnvelope(r.value));
        } catch { /* skip unreadable entries */ }
      }));
      let cur = null;
      try { cur = current ? summary(validateEnvelope(current.value)) : null; } catch { /* unreadable current */ }
      return sendJson(res, 200, { current: cur, history: history.filter(Boolean) }, NO_STORE);
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, POST", ...NO_STORE });
    }

    assertSameOrigin(req); //                CSRF 1: same-origin only
    assertJsonRequest(req);
    const session = requireSession(req); //  must hold a valid, unexpired session
    assertCsrf(req, session); //             CSRF 2: per-session token in a custom header
    const body = await readJsonBody(req, LIMITS.maxBodyBytes);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "bad_request", "Invalid request.");

    const action = body.action === undefined ? "publish" : body.action;
    const baseVersion = "baseVersion" in body ? body.baseVersion : undefined;
    if (baseVersion !== undefined && baseVersion !== null) validateVersionId(baseVersion);
    const current = await readCurrent();
    const now = new Date();

    if (action === "publish") {
      const extra = Object.keys(body).filter((k) => !["action", "source", "baseVersion"].includes(k));
      if (extra.length) throw new HttpError(422, "invalid_payload", `Unexpected field "${extra[0]}".`);
      validateSource(body.source);
      const envelope = { schemaVersion: 1, version: newVersion(now), publishedAt: now.toISOString(), action: "publish", source: body.source };
      return sendJson(res, 200, { ok: true, ...(await commit(envelope, current, baseVersion)) }, NO_STORE);
    }

    if (action === "rollback") {
      const version = validateVersionId(body.version);
      const old = await readHistory(version);
      if (!old) throw new HttpError(404, "not_found", "That version no longer exists.");
      const prev = validateEnvelope(old.value);
      const envelope = {
        schemaVersion: 1, version: newVersion(now), publishedAt: now.toISOString(),
        action: "rollback", rollbackOf: prev.version, source: prev.source,
      };
      return sendJson(res, 200, { ok: true, ...(await commit(envelope, current, baseVersion)) }, NO_STORE);
    }

    throw new HttpError(400, "bad_action", "Unknown action.");
  } catch (err) {
    return sendError(res, err, "publish");
  }
}
