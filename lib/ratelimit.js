import { LIMITS, rateLimitPath } from "./config.js";
import { HttpError } from "./http.js";
import { readJson, writeJson } from "./store.js";

/**
 * Persistent login throttling kept in the SAME private Blob store (no extra service, no in-memory state, so it holds
 * across serverless instances). Each counter is a tiny JSON blob updated with an ETag-conditional write (ifMatch), so
 * two parallel guesses cannot both be counted as one. If a counter cannot be updated safely the attempt is DENIED
 * (fail closed). Counters are per client address (hashed) and global.
 */

const GLOBAL = "login-global";

async function load(name) {
  const r = await readJson(rateLimitPath(name));
  return { state: r?.value || { failures: [], lockedUntil: 0 }, etag: r?.etag };
}

const retryAfter = (until, now) => Math.max(1, Math.ceil((until - now) / 1000));

/** Throws 429 if this client (or the whole login endpoint) is currently locked. */
export async function assertNotLocked(ipHash, now = Date.now()) {
  for (const name of [`login-ip-${ipHash}`, GLOBAL]) {
    const { state } = await load(name);
    if (state.lockedUntil > now) {
      throw new HttpError(429, "too_many_attempts", "Too many failed sign-in attempts. Try again later.", {
        "Retry-After": String(retryAfter(state.lockedUntil, now)),
      });
    }
  }
}

async function bump(name, max, now) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { state, etag } = await load(name);
    const failures = (state.failures || []).filter((t) => t > now - LIMITS.loginWindowMs);
    failures.push(now);
    const next = { failures, lockedUntil: failures.length >= max ? now + LIMITS.loginLockMs : state.lockedUntil || 0 };
    try {
      // First write is create-only (overwrite:false); later writes are ETag-conditional.
      await writeJson(rateLimitPath(name), next, { overwrite: !!etag, ifMatch: etag });
      return next;
    } catch (err) {
      if (err?.name !== "BlobPreconditionFailedError" && !/precondition|already exists/i.test(String(err?.message))) throw err;
    }
  }
  // Heavy contention is itself suspicious: deny rather than let an uncounted guess through.
  throw new HttpError(429, "too_many_attempts", "Too many failed sign-in attempts. Try again later.", { "Retry-After": "60" });
}

export async function recordFailure(ipHash, now = Date.now()) {
  await bump(`login-ip-${ipHash}`, LIMITS.loginMaxFailuresPerIp, now);
  await bump(GLOBAL, LIMITS.loginMaxFailuresGlobal, now);
}

/** A successful sign-in clears that client's own failure history. */
export async function recordSuccess(ipHash) {
  const { state, etag } = await load(`login-ip-${ipHash}`);
  if (!state.failures.length && !state.lockedUntil) return;
  try {
    await writeJson(rateLimitPath(`login-ip-${ipHash}`), { failures: [], lockedUntil: 0 }, { overwrite: true, ifMatch: etag });
  } catch {
    /* a stale counter only makes the limiter stricter, never weaker */
  }
}
