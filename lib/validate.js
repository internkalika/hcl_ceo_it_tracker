import { LIMITS } from "./config.js";
import { HttpError } from "./http.js";

/**
 * Structural validation of the parsed workbook ("source") that the browser's existing Excel parser produces.
 * The parser itself is NOT reimplemented here: this only checks that what arrives has exactly the shape and value
 * ranges that parser emits, so a malformed or hostile payload can never be published to every viewer.
 */

const STATUSES = ["delayed", "on_hold", "working", "in_progress", "not_started", "completed", "unmapped"];
const DATE_KINDS = ["exact", "vague", "ongoing", "partial", "tbs", "tbd", "none", "multiple"];
const PROJECT_KEYS = ["key", "externalId", "name", "objective", "department", "reviewer", "sourceStatus", "mappedStatus", "expectedEndRaw", "expectedEndKind", "expectedEndDate", "expectedEndNote", "updates", "milestones", "riskReasons", "reviewFlags", "sourceRows", "sourceHidden"];
const SOURCE_KEYS = ["fileName", "sheetName", "savedAt", "projects"];
const MAX = { short: 300, text: 20000, name: 300, list: 200 };
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function fail(path, why) {
  throw new HttpError(422, "invalid_payload", `Invalid data at ${path}: ${why}.`);
}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function exactKeys(v, allowed, path) {
  if (!isObj(v)) fail(path, "expected an object");
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(path, `unexpected field "${k}"`);
  for (const k of allowed) if (!(k in v)) fail(path, `missing field "${k}"`);
}
function str(v, path, { max = MAX.short, min = 0, nullable = false } = {}) {
  if (v === null && nullable) return;
  if (typeof v !== "string") fail(path, nullable ? "expected text or null" : "expected text");
  if (v.length < min) fail(path, "must not be empty");
  if (v.length > max) fail(path, `longer than ${max} characters`);
  if (CONTROL.test(v)) fail(path, "contains control characters");
}
function int(v, path, min = 1, max = 1_000_000) {
  if (!Number.isInteger(v) || v < min || v > max) fail(path, `expected a whole number from ${min} to ${max}`);
}
function bool(v, path) {
  if (typeof v !== "boolean") fail(path, "expected true or false");
}
function oneOf(v, list, path, nullable = false) {
  if (v === null && nullable) return;
  if (!list.includes(v)) fail(path, `must be one of ${list.join(", ")}`);
}
/** A real calendar date, YYYY-MM-DD, years 2000-2100 (the same range the parser accepts). */
export function isRealDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
function date(v, path, nullable = true) {
  if (v === null && nullable) return;
  if (typeof v !== "string" || !isRealDate(v)) fail(path, "expected a real date as YYYY-MM-DD between 2000 and 2100");
}
function timestamp(v, path) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) || Number.isNaN(Date.parse(v))) {
    fail(path, "expected an ISO timestamp (UTC)");
  }
  const y = Number(v.slice(0, 4));
  if (y < 2000 || y > 2100) fail(path, "year out of range");
}
function list(v, path, max, each) {
  if (!Array.isArray(v)) fail(path, "expected a list");
  if (v.length > max) fail(path, `more than ${max} items`);
  v.forEach((x, i) => each(x, `${path}[${i}]`));
}
function codeMessage(x, path) {
  exactKeys(x, ["code", "message"], path);
  str(x.code, `${path}.code`, { min: 1, max: 80 });
  str(x.message, `${path}.message`, { max: 1000 });
}

function project(p, path) {
  exactKeys(p, PROJECT_KEYS, path);
  str(p.key, `${path}.key`, { min: 1, max: MAX.name });
  str(p.externalId, `${path}.externalId`, { nullable: true });
  str(p.name, `${path}.name`, { min: 1, max: MAX.name });
  str(p.objective, `${path}.objective`, { nullable: true, max: MAX.text });
  str(p.department, `${path}.department`, { nullable: true });
  str(p.reviewer, `${path}.reviewer`, { nullable: true });
  str(p.sourceStatus, `${path}.sourceStatus`, { nullable: true });
  oneOf(p.mappedStatus, STATUSES, `${path}.mappedStatus`, true);
  str(p.expectedEndRaw, `${path}.expectedEndRaw`, { nullable: true, max: MAX.text });
  oneOf(p.expectedEndKind, DATE_KINDS, `${path}.expectedEndKind`);
  date(p.expectedEndDate, `${path}.expectedEndDate`);
  if (p.expectedEndKind === "exact" && p.expectedEndDate === null) fail(`${path}.expectedEndDate`, 'required when the date kind is "exact"');
  str(p.expectedEndNote, `${path}.expectedEndNote`, { nullable: true, max: 1000 });
  list(p.updates, `${path}.updates`, MAX.list, (u, up) => {
    exactKeys(u, ["position", "text", "sourceRow"], up);
    int(u.position, `${up}.position`);
    str(u.text, `${up}.text`, { max: MAX.text });
    int(u.sourceRow, `${up}.sourceRow`);
  });
  list(p.milestones, `${path}.milestones`, MAX.list, (m, mp) => {
    exactKeys(m, ["position", "label", "rawText", "kind", "date", "note", "sourceRow"], mp);
    int(m.position, `${mp}.position`);
    str(m.label, `${mp}.label`, { nullable: true });
    str(m.rawText, `${mp}.rawText`, { max: MAX.text });
    oneOf(m.kind, DATE_KINDS, `${mp}.kind`);
    date(m.date, `${mp}.date`);
    str(m.note, `${mp}.note`, { nullable: true, max: 1000 });
    int(m.sourceRow, `${mp}.sourceRow`);
  });
  list(p.riskReasons, `${path}.riskReasons`, MAX.list, codeMessage);
  list(p.reviewFlags, `${path}.reviewFlags`, MAX.list, codeMessage);
  list(p.sourceRows, `${path}.sourceRows`, 1000, (r, rp) => int(r, rp));
  bool(p.sourceHidden, `${path}.sourceHidden`);
}

/** Validates and returns a clean copy of the source. Throws HttpError(422) with a path to the first problem. */
export function validateSource(source) {
  exactKeys(source, SOURCE_KEYS, "source");
  str(source.fileName, "source.fileName", { min: 1, max: 255 });
  str(source.sheetName, "source.sheetName", { min: 1, max: 255 });
  timestamp(source.savedAt, "source.savedAt");
  if (!Array.isArray(source.projects)) fail("source.projects", "expected a list");
  if (source.projects.length < 1) fail("source.projects", "has no projects");
  if (source.projects.length > LIMITS.maxProjects) fail("source.projects", `more than ${LIMITS.maxProjects} projects`);
  source.projects.forEach((p, i) => project(p, `source.projects[${i}]`));
  return source;
}

const VERSION_RE = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/;
/** A version id is the ONLY user input that becomes part of a storage path, so it is matched exactly. */
export function validateVersionId(v) {
  if (typeof v !== "string" || !VERSION_RE.test(v)) throw new HttpError(400, "bad_version", "Invalid version id.");
  return v;
}

/** Re-validate a stored envelope before it is ever served or restored. */
export function validateEnvelope(env) {
  if (!isObj(env) || env.schemaVersion !== 1) throw new HttpError(422, "invalid_payload", "Stored data has an unknown format.");
  validateVersionId(env.version);
  timestamp(env.publishedAt, "publishedAt");
  validateSource(env.source);
  return env;
}
