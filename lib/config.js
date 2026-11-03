/**
 * Server-side configuration. Nothing in this file is ever sent to the browser.
 *
 * Environment variables used (all server-only, none are prefixed for client exposure):
 *   IT_TRACKER_READ_WRITE_TOKEN  Blob read-write token. Passed EXPLICITLY to every SDK call.
 *   IT_TRACKER_STORE_ID          Expected Blob store id; must match the id embedded in the token.
 *   IT_TRACKER_PUBLISH_SECRET    Shared passphrase for publishers.
 *   IT_TRACKER_SESSION_SECRET    Signs session cookies / CSRF tokens (must differ from the passphrase).
 *   IT_TRACKER_WEBHOOK_PUBLIC_KEY is reserved; it is deliberately not used by this feature.
 *
 * BLOB_READ_WRITE_TOKEN is never read here and never assumed to exist.
 */

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

/** Preview and Production data never share a path. Anything unrecognised fails closed. */
const PREFIXES = {
  production: "it-tracker/production",
  preview: "it-tracker/preview",
  // `vercel dev` / local runs are treated as Preview so they can never touch Production data.
  development: "it-tracker/preview",
};

/** The deployment environment as Vercel reports it (VERCEL_ENV), never from request data. */
export function deploymentEnv() {
  const env = process.env.VERCEL_ENV;
  if (!env || !Object.prototype.hasOwnProperty.call(PREFIXES, env)) {
    throw new ConfigError("unknown_environment", "Deployment environment is not recognised.");
  }
  return env;
}

export function dataPrefix() {
  return PREFIXES[deploymentEnv()];
}

export const currentPath = () => `${dataPrefix()}/current.json`;
export const historyPrefix = () => `${dataPrefix()}/history/`;
export const historyPath = (version) => `${historyPrefix()}${version}.json`;
export const rateLimitPath = (name) => `${dataPrefix()}/ratelimit/${name}.json`;

/** Refuse any pathname outside this environment's own prefix (defence in depth against path bugs). */
export function assertOwnPath(pathname) {
  const prefix = `${dataPrefix()}/`;
  if (typeof pathname !== "string" || !pathname.startsWith(prefix) || pathname.includes("..") || pathname.includes("//")) {
    throw new ConfigError("path_outside_environment", "Refusing to access a path outside this environment.");
  }
  return pathname;
}

/**
 * The Blob read-write token. Read from the custom variable only. The token's embedded store id must match
 * IT_TRACKER_STORE_ID so a token for the wrong store can never be used by mistake.
 */
export function blobToken() {
  const token = process.env.IT_TRACKER_READ_WRITE_TOKEN;
  if (!token || typeof token !== "string") {
    throw new ConfigError("missing_blob_token", "Blob storage is not configured.");
  }
  const expected = process.env.IT_TRACKER_STORE_ID;
  if (!expected) throw new ConfigError("missing_store_id", "Blob storage is not configured.");
  const parts = token.split("_"); // vercel_blob_rw_<storeId>_<secret>
  const tokenStore = (parts[3] || "").toLowerCase();
  const wanted = expected.trim().toLowerCase().replace(/^store_/, "");
  if (parts[0] !== "vercel" || parts[1] !== "blob" || !tokenStore || tokenStore !== wanted) {
    throw new ConfigError("store_mismatch", "Blob token does not belong to the configured store.");
  }
  return token;
}

/** Secrets for authentication. Fails closed when absent or weak. */
export function authSecrets() {
  const publishSecret = process.env.IT_TRACKER_PUBLISH_SECRET;
  const sessionSecret = process.env.IT_TRACKER_SESSION_SECRET;
  if (!publishSecret || publishSecret.length < 12) {
    throw new ConfigError("weak_publish_secret", "Publishing is not configured.");
  }
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new ConfigError("weak_session_secret", "Publishing is not configured.");
  }
  if (publishSecret === sessionSecret) {
    throw new ConfigError("secrets_not_distinct", "Publishing is not configured.");
  }
  return { publishSecret, sessionSecret };
}

export const LIMITS = {
  maxBodyBytes: 2 * 1024 * 1024,
  maxProjects: 500,
  sessionSeconds: 30 * 60,
  loginWindowMs: 15 * 60 * 1000,
  loginMaxFailuresPerIp: 5,
  loginMaxFailuresGlobal: 60,
  loginLockMs: 15 * 60 * 1000,
  historyListLimit: 20,
};
