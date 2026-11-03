import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fake from "./fake-blob.mjs";
import { SECRETS, setEnv, startServer } from "./harness.mjs";
import { loadEngine, loadEmbedded, fixture } from "./engine-util.mjs";
import { createSession } from "../lib/session.js";

const ENGINE = loadEngine();
let srv, base, source1, source2;
const errors = [];
const origError = console.error;

before(async () => {
  console.error = (...a) => { errors.push(a.join(" ")); };
  setEnv("preview");
  srv = await startServer();
  base = srv.base;
  source1 = (await ENGINE.readWorkbook(fixture("sample.xlsx"), "sample.xlsx", Date.parse("2026-11-03T05:00:00Z"))).source;
  source2 = (await ENGINE.readWorkbook(fixture("sample-v2.xlsx"), "sample-v2.xlsx", Date.parse("2026-11-03T06:00:00Z"))).source;
});
after(async () => { console.error = origError; await srv.close(); });
beforeEach(() => { fake.reset(); setEnv("preview"); });

/* ---- tiny client ---- */
const ORIGIN = () => base;
async function call(path, { method = "GET", body, cookie, csrf, origin = ORIGIN(), ip, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (origin) h.Origin = origin;
  if (cookie) h.Cookie = cookie;
  if (csrf) h["X-CSRF-Token"] = csrf;
  if (ip) h["x-vercel-forwarded-for"] = ip;
  let payload;
  if (raw !== undefined) { payload = raw; h["Content-Type"] = h["Content-Type"] || "application/json"; }
  else if (body !== undefined) { payload = JSON.stringify(body); h["Content-Type"] = h["Content-Type"] || "application/json"; }
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers, setCookie: res.headers.getSetCookie() };
}
async function login(ip = "10.0.0.1", passphrase = SECRETS.publish) {
  const r = await call("/api/auth", { method: "POST", body: { passphrase }, ip });
  if (r.status !== 200) return { r };
  return { r, cookie: r.setCookie[0].split(";")[0], csrf: r.json.csrfToken };
}
async function publish(session, source, extra = {}) {
  return call("/api/publish", { method: "POST", cookie: session.cookie, csrf: session.csrf, body: { action: "publish", source, ...extra } });
}
const prefixOf = (p) => p.split("/").slice(0, 2).join("/");

/* ===================== configuration & Blob token handling ===================== */
test("every Blob call passes the custom token explicitly, private access, and BLOB_READ_WRITE_TOKEN is never needed", async () => {
  assert.equal(process.env.BLOB_READ_WRITE_TOKEN, undefined);
  const s = await login();
  await publish(s, source1);
  await call("/api/data");
  assert.ok(fake.calls.length > 0);
  for (const c of fake.calls) { assert.equal(c.tokenOk, true, `${c.op} ${c.pathname}`); if (c.op !== "del") assert.ok(c.access === "private" || c.op === "list", `${c.op} must be private`); }
});

test("a decoy BLOB_READ_WRITE_TOKEN is ignored; with the custom token missing the API fails closed and makes no Blob call", async () => {
  process.env.BLOB_READ_WRITE_TOKEN = SECRETS.decoy;
  delete process.env.IT_TRACKER_READ_WRITE_TOKEN;
  const r = await call("/api/data");
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "not_configured");
  assert.equal(fake.calls.length, 0);
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

test("a token for a different store than IT_TRACKER_STORE_ID is refused", async () => {
  process.env.IT_TRACKER_STORE_ID = "store_someotherstore";
  const r = await call("/api/data");
  assert.equal(r.status, 503);
  assert.equal(fake.calls.length, 0);
});

test("unknown deployment environment fails closed", async () => {
  process.env.VERCEL_ENV = "";
  assert.equal((await call("/api/data")).status, 503);
  process.env.VERCEL_ENV = "staging";
  assert.equal((await call("/api/data")).status, 503);
  assert.equal(fake.calls.length, 0);
});

test("weak/missing/identical auth secrets disable sign-in", async () => {
  process.env.IT_TRACKER_SESSION_SECRET = "short";
  assert.equal((await login()).r.status, 503);
  process.env.IT_TRACKER_SESSION_SECRET = SECRETS.publish.padEnd(40, "x");
  process.env.IT_TRACKER_PUBLISH_SECRET = SECRETS.publish.padEnd(40, "x");
  assert.equal((await login()).r.status, 503, "same value for both secrets");
});

/* ===================== authentication ===================== */
test("login: correct passphrase gives a hardened cookie; wrong/missing ones are refused", async () => {
  const ok = await login("10.1.1.1");
  assert.equal(ok.r.status, 200);
  const c = ok.r.setCookie[0];
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Max-Age=1800", "Path=/api"]) assert.ok(c.includes(flag), `cookie has ${flag}: ${c}`);
  assert.ok(ok.csrf && ok.csrf.length > 20);
  assert.ok(!c.includes(SECRETS.publish) && !c.includes(SECRETS.session));

  const bad = await login("10.1.1.2", "wrong-passphrase");
  assert.equal(bad.r.status, 401);
  assert.equal(bad.r.json.error, "invalid_credentials");
  assert.equal(bad.r.setCookie.length, 0);
  assert.equal((await call("/api/auth", { method: "POST", body: {}, ip: "10.1.1.3" })).status, 400);
  assert.equal((await call("/api/auth", { method: "POST", body: { passphrase: 12345 }, ip: "10.1.1.3" })).status, 400);
});

test("login and logout reject foreign/missing Origin and non-JSON bodies (CSRF)", async () => {
  assert.equal((await call("/api/auth", { method: "POST", body: { passphrase: SECRETS.publish }, origin: "https://evil.example" })).status, 403);
  assert.equal((await call("/api/auth", { method: "POST", body: { passphrase: SECRETS.publish }, origin: null })).status, 403);
  assert.equal((await call("/api/auth", { method: "POST", raw: "passphrase=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 415);
  assert.equal((await call("/api/auth", { method: "POST", body: { passphrase: SECRETS.publish }, headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await call("/api/auth", { method: "DELETE", origin: "https://evil.example" })).status, 403);
  const out = await call("/api/auth", { method: "DELETE" });
  assert.equal(out.status, 200);
  assert.match(out.setCookie[0], /Max-Age=0/);
});

test("GET /api/auth reports session state and never returns secrets", async () => {
  assert.deepEqual((await call("/api/auth")).json, { authenticated: false });
  const s = await login();
  const r = await call("/api/auth", { cookie: s.cookie });
  assert.equal(r.json.authenticated, true);
  assert.equal(r.json.csrfToken, s.csrf);
  assert.deepEqual(Object.keys(r.json).sort(), ["authenticated", "csrfToken", "expiresAt"]);
});

test("persistent rate limit: 5 wrong passphrases lock that client even for the right passphrase; others are unaffected", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login("10.9.9.9", "nope" + i)).r.status, 401);
  const locked = await login("10.9.9.9", SECRETS.publish);
  assert.equal(locked.r.status, 429);
  assert.ok(Number(locked.r.headers.get("retry-after")) > 0);
  assert.equal((await login("10.9.9.10")).r.status, 200, "a different client is not locked");
  // The lock lives in Blob (not in memory), so it survives any new serverless instance:
  const keys = [...fake.store.keys()].filter((k) => k.includes("/ratelimit/"));
  assert.ok(keys.length >= 2 && keys.every((k) => k.startsWith("it-tracker/preview/")));
  assert.ok(!keys.some((k) => k.includes("10.9.9.9")), "client address is stored hashed");
});

test("rate limit: parallel guesses are all counted (ETag-conditional writes) and the burst is locked out", async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => login("10.7.7.7", "guess" + i)));
  const statuses = results.map((x) => x.r.status);
  assert.ok(statuses.every((s) => s === 401 || s === 429));
  assert.ok(statuses.filter((s) => s === 401).length <= 5, `at most 5 wrong guesses evaluated, got ${statuses}`);
  assert.equal((await login("10.7.7.7")).r.status, 429);
});

test("successful login clears that client's earlier failures", async () => {
  for (let i = 0; i < 3; i++) await login("10.5.5.5", "bad" + i);
  assert.equal((await login("10.5.5.5")).r.status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await login("10.5.5.5", "bad" + i)).r.status, 401);
  assert.equal((await login("10.5.5.5")).r.status, 200);
});

/* ===================== publishing: authorisation ===================== */
test("unauthenticated publish, history and rollback are refused and write nothing", async () => {
  assert.equal((await call("/api/publish", { method: "POST", body: { action: "publish", source: source1 } })).status, 401);
  assert.equal((await call("/api/publish")).status, 401);
  assert.equal((await call("/api/publish", { method: "POST", body: { action: "rollback", version: "20261103T000000000Z-deadbeef" } })).status, 401);
  assert.equal([...fake.store.keys()].filter((k) => !k.includes("ratelimit")).length, 0);
});

test("publish needs the CSRF token, a same-origin request and a valid cookie", async () => {
  const s = await login();
  const body = { action: "publish", source: source1 };
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie, body })).status, 403, "no CSRF header");
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: "x".repeat(43), body })).status, 403, "wrong CSRF header");
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, body, origin: "https://evil.example" })).status, 403, "foreign origin");
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, body, origin: null })).status, 403, "no origin");
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, raw: JSON.stringify(body), headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie.slice(0, -3) + "AAA", csrf: s.csrf, body })).status, 401, "tampered signature");
  assert.equal([...fake.store.keys()].filter((k) => !k.includes("ratelimit")).length, 0);
  assert.equal((await publish(s, source1)).status, 200);
});

test("expired sessions, forged sessions and sessions from another environment are refused", async () => {
  const body = { action: "publish", source: source1 };
  const expired = createSession(Date.now() - 2 * 3600 * 1000).token;
  assert.equal((await call("/api/publish", { method: "POST", cookie: `it_tracker_session=${expired}`, csrf: "x", body })).status, 401);
  const prod = (() => { process.env.VERCEL_ENV = "production"; const t = createSession().token; process.env.VERCEL_ENV = "preview"; return t; })();
  assert.equal((await call("/api/publish", { method: "POST", cookie: `it_tracker_session=${prod}`, csrf: "x", body })).status, 401, "production cookie rejected in preview");
  const forged = "v1." + Buffer.from(JSON.stringify({ sid: "a", iat: 1, exp: 99999999999, env: "preview" })).toString("base64url") + ".AAAA";
  assert.equal((await call("/api/publish", { method: "POST", cookie: `it_tracker_session=${forged}`, csrf: "x", body })).status, 401);
  // a session signed with a different secret
  process.env.IT_TRACKER_SESSION_SECRET = "another-completely-different-secret-value-0123456789";
  const other = createSession().token;
  process.env.IT_TRACKER_SESSION_SECRET = SECRETS.session;
  assert.equal((await call("/api/publish", { method: "POST", cookie: `it_tracker_session=${other}`, csrf: "x", body })).status, 401);
});

/* ===================== publishing: validation ===================== */
test("payload validation rejects malformed data with a 4xx and publishes nothing", async () => {
  const s = await login();
  const clone = () => JSON.parse(JSON.stringify(source1));
  const mut = (fn) => { const x = clone(); fn(x); return x; };
  const cases = {
    "missing project field": mut((x) => delete x.projects[0].name),
    "unknown project field": mut((x) => (x.projects[0].evil = "<script>")),
    "unknown source field": mut((x) => (x.extra = 1)),
    "impossible date": mut((x) => { x.projects[0].expectedEndKind = "exact"; x.projects[0].expectedEndDate = "2026-02-30"; }),
    "date out of range": mut((x) => { x.projects[0].expectedEndKind = "exact"; x.projects[0].expectedEndDate = "1999-01-01"; }),
    "exact without date": mut((x) => { x.projects[0].expectedEndKind = "exact"; x.projects[0].expectedEndDate = null; }),
    "bad status": mut((x) => (x.projects[0].mappedStatus = "hacked")),
    "bad date kind": mut((x) => (x.projects[0].expectedEndKind = "weird")),
    "empty name": mut((x) => (x.projects[0].name = "")),
    "name wrong type": mut((x) => (x.projects[0].name = 42)),
    "control characters": mut((x) => (x.projects[0].name = "a\u0000b")),
    "huge text field": mut((x) => (x.projects[0].objective = "x".repeat(30000))),
    "bad savedAt": mut((x) => (x.savedAt = "yesterday")),
    "no projects": mut((x) => (x.projects = [])),
    "too many projects": mut((x) => (x.projects = Array.from({ length: 501 }, () => clone().projects[0]))),
    "milestone bad date": mut((x) => { x.projects[0].milestones = [{ position: 1, label: null, rawText: "r", kind: "exact", date: "2026-13-01", note: null, sourceRow: 2 }]; }),
    "projects not a list": mut((x) => (x.projects = {})),
  };
  for (const [name, bad] of Object.entries(cases)) {
    const r = await publish(s, bad);
    assert.ok(r.status === 422 || r.status === 413, `${name}: expected 4xx got ${r.status}`);
  }
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, body: { action: "publish", source: source1, evil: 1 } })).status, 422);
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, raw: "{not json" })).status, 400);
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, body: [1] })).status, 400);
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, body: { action: "delete-everything" } })).status, 400);
  assert.equal([...fake.store.keys()].filter((k) => !k.includes("ratelimit")).length, 0, "nothing was written");
});

test("oversized request bodies are rejected (413) before parsing", async () => {
  const s = await login();
  const big = { action: "publish", source: { ...source1, pad: "x".repeat(2.2 * 1024 * 1024) } };
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, body: big })).status, 413);
  // chunked/unknown length: streaming cap still applies
  const r = await fetch(base + "/api/publish", {
    method: "POST", headers: { Origin: base, Cookie: s.cookie, "X-CSRF-Token": s.csrf, "Content-Type": "application/json" },
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":"' + "x".repeat(2.2 * 1024 * 1024) + '"}')); c.close(); } }), duplex: "half",
  });
  assert.equal(r.status, 413);
});

/* ===================== publishing, public reading, caching ===================== */
test("publish -> anyone can read it without logging in; ETag/304 and cache headers", async () => {
  assert.equal((await call("/api/data")).status, 404, "nothing published yet");
  const s = await login();
  const p = await publish(s, source1);
  assert.equal(p.status, 200);
  assert.equal(p.json.projectCount, 6);
  assert.match(p.json.version, /^\d{8}T\d{9}Z-[0-9a-f]{8}$/);

  const r = await call("/api/data", { origin: null }); // public: no cookie, no origin
  assert.equal(r.status, 200);
  assert.equal(r.json.version, p.json.version);
  assert.equal(r.json.publishedAt, p.json.publishedAt);
  assert.deepEqual(r.json.source, source1);
  assert.equal(r.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(r.headers.get("vercel-cdn-cache-control"), "max-age=10");
  const etag = r.headers.get("etag");
  assert.equal(etag, `"${p.json.version}"`);
  const again = await call("/api/data", { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
  assert.equal(again.text, "");

  // A new publish changes the ETag, so a revalidating client gets the new data immediately.
  const p2 = await publish(s, source2);
  const fresh = await call("/api/data", { headers: { "If-None-Match": etag } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.version, p2.json.version);
  assert.equal(fresh.json.source.projects.length, 2);
  // read-only: public cannot write
  assert.equal((await call("/api/data", { method: "POST", body: {} })).status, 405);
});

test("the Blob URL, token and store id never appear in public data", async () => {
  const s = await login();
  await publish(s, source1);
  const r = await call("/api/data");
  assert.ok(!/blob|vercel_blob|teststore123|https?:\/\//i.test(JSON.stringify({ ...r.json, source: undefined })));
  assert.deepEqual(Object.keys(r.json).sort(), ["publishedAt", "schemaVersion", "source", "version"]);
});

/* ===================== Preview / Production isolation ===================== */
test("Preview and Production use separate paths and can never read or write each other's data", async () => {
  // Seed Production directly with a recognisable marker
  setEnv("production");
  const prodSession = await login("10.2.2.2");
  const prodMarker = JSON.parse(JSON.stringify(source1)); prodMarker.fileName = "PRODUCTION-MARKER.xlsx";
  assert.equal((await publish(prodSession, prodMarker)).status, 200);
  const prodKeys = [...fake.store.keys()].filter((k) => !k.includes("ratelimit"));
  assert.ok(prodKeys.includes("it-tracker/production/current.json"));
  assert.ok(prodKeys.every((k) => k.startsWith("it-tracker/production/")));
  const prodVersion = (await call("/api/data")).json.version;

  // Preview: sees nothing from Production
  setEnv("preview");
  assert.equal((await call("/api/data")).status, 404, "preview must not read production data");
  const callsBefore = fake.calls.length;
  const prevSession = await login("10.2.2.3");
  const previewSource = JSON.parse(JSON.stringify(source2));
  assert.equal((await publish(prevSession, previewSource)).status, 200);
  const pv = await call("/api/data");
  assert.equal(pv.json.source.fileName, "sample-v2.xlsx");

  // Every storage path touched while in Preview is a Preview path
  for (const c of fake.calls.slice(callsBefore)) assert.ok(c.pathname.startsWith("it-tracker/preview/"), `preview touched ${c.pathname}`);
  // Production data is untouched by Preview activity
  assert.equal(JSON.parse(fake.store.get("it-tracker/production/current.json").body).source.fileName, "PRODUCTION-MARKER.xlsx");

  // Production still serves its own data, unaffected by Preview publishes
  setEnv("production");
  const prod = await call("/api/data");
  assert.equal(prod.json.version, prodVersion);
  assert.equal(prod.json.source.fileName, "PRODUCTION-MARKER.xlsx");
  const pc = fake.calls.length;
  await call("/api/data");
  for (const c of fake.calls.slice(pc)) assert.ok(c.pathname.startsWith("it-tracker/production/"), `production touched ${c.pathname}`);
});

test("rollback cannot be pointed at another environment's data or any other path", async () => {
  setEnv("production");
  const ps = await login("10.3.3.3");
  const pv = (await publish(ps, source1)).json.version;
  setEnv("preview");
  const s = await login("10.3.3.4");
  // The production version id is well-formed but does not exist under the PREVIEW prefix
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, body: { action: "rollback", version: pv } })).status, 404);
  for (const evil of ["../production/current", "../../x", "20261103T000000000Z-deadbeef/../../production/current", "current", "", 5, null, "a".repeat(500)]) {
    const r = await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, body: { action: "rollback", version: evil } });
    assert.equal(r.status, 400, `version ${JSON.stringify(evil)}`);
  }
  assert.equal(fake.calls.filter((c) => c.pathname.includes("..")).length, 0);
});

/* ===================== history & rollback ===================== */
test("history is kept, listed newest first, and rollback restores an earlier version (and is itself reversible)", async () => {
  const s = await login();
  const v1 = (await publish(s, source1)).json;
  const v2 = (await publish(s, source2, { baseVersion: v1.version })).json;
  assert.notEqual(v1.version, v2.version);

  let h = (await call("/api/publish", { cookie: s.cookie })).json;
  assert.equal(h.current.version, v2.version);
  assert.deepEqual(h.history.map((x) => x.version), [v2.version, v1.version]);
  assert.deepEqual(h.history.map((x) => x.projectCount), [2, 6]);

  const rb = await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, body: { action: "rollback", version: v1.version, baseVersion: v2.version } });
  assert.equal(rb.status, 200);
  assert.equal(rb.json.action, "rollback");
  assert.equal(rb.json.rollbackOf, v1.version);
  assert.notEqual(rb.json.version, v1.version, "a rollback is a NEW recorded version");
  const live = (await call("/api/data")).json;
  assert.equal(live.version, rb.json.version);
  assert.deepEqual(live.source, source1);

  h = (await call("/api/publish", { cookie: s.cookie })).json;
  assert.equal(h.history.length, 3, "nothing was deleted");
  assert.equal(h.history[0].action, "rollback");
  // undo the rollback by restoring v2
  assert.equal((await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, body: { action: "rollback", version: v2.version } })).status, 200);
  assert.equal((await call("/api/data")).json.source.fileName, "sample-v2.xlsx");
});

test("a corrupted history entry cannot be restored", async () => {
  const s = await login();
  const v1 = (await publish(s, source1)).json;
  const key = `it-tracker/preview/history/${v1.version}.json`;
  const env = JSON.parse(fake.store.get(key).body); env.source.projects[0].mappedStatus = "tampered";
  fake.store.get(key).body = JSON.stringify(env);
  const r = await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, body: { action: "rollback", version: v1.version } });
  assert.equal(r.status, 422);
  assert.equal((await call("/api/data")).json.source.projects[0].mappedStatus !== "tampered", true);
});

test("publish is safe against concurrent publishers: stale baseVersion and racing writes are rejected, nothing is lost", async () => {
  const s = await login();
  const v1 = (await publish(s, source1)).json;
  const stale = await publish(s, source2, { baseVersion: "20200101T000000000Z-00000000" });
  assert.equal(stale.status, 409);
  assert.equal((await call("/api/data")).json.version, v1.version, "current unchanged after a rejected publish");
  assert.equal((await publish(s, source2, { baseVersion: null })).status, 409, "client thought nothing was published");

  // two publishes racing from the same base: exactly one wins, the loser leaves no orphan history entry
  const results = await Promise.all([publish(s, source1, { baseVersion: v1.version }), publish(s, source2, { baseVersion: v1.version })]);
  const codes = results.map((r) => r.status).sort();
  assert.ok(codes[0] === 200 && (codes[1] === 200 || codes[1] === 409), `got ${codes}`);
  const history = [...fake.store.keys()].filter((k) => k.includes("/history/"));
  const live = (await call("/api/data")).json.version;
  assert.ok(history.some((k) => k.includes(live)), "the live version is in history");
  const wins = results.filter((r) => r.status === 200).length;
  assert.equal(history.length, 1 + wins, "no orphan history entries from rejected writes");
});

/* ===================== secrets never leak ===================== */
test("no response, header or log line ever contains a secret", async () => {
  const s = await login("10.4.4.4");
  await login("10.4.4.5", "wrong");
  await publish(s, source1);
  await call("/api/data"); await call("/api/auth", { cookie: s.cookie }); await call("/api/publish", { cookie: s.cookie });
  await call("/api/publish", { method: "POST", cookie: s.cookie, csrf: s.csrf, raw: "{bad" });
  process.env.IT_TRACKER_READ_WRITE_TOKEN = ""; await call("/api/data");           // config error path
  setEnv("preview");
  const secrets = [SECRETS.publish, SECRETS.session, process.env.IT_TRACKER_READ_WRITE_TOKEN, "AbCdEfGhIjKlMnOpQrStUvWxYz", "vercel_blob_rw_", process.env.IT_TRACKER_WEBHOOK_PUBLIC_KEY];
  const everything = JSON.stringify(srv.log) + errors.join("\n");
  for (const secret of secrets) assert.ok(!everything.includes(secret), `leaked: ${secret.slice(0, 8)}...`);
  // The session cookie value itself is only ever sent as an HttpOnly Set-Cookie, never in a body
  const cookieValue = s.cookie.split("=")[1];
  assert.ok(!JSON.stringify(srv.log.map((l) => l.body)).includes(cookieValue));
});

test("the page source (index.html) contains no server secret names or values", async () => {
  const { html } = await import("./engine-util.mjs");
  for (const needle of [SECRETS.publish, SECRETS.session, "vercel_blob_rw_", "IT_TRACKER_READ_WRITE_TOKEN", "IT_TRACKER_PUBLISH_SECRET", "IT_TRACKER_SESSION_SECRET", "BLOB_READ_WRITE_TOKEN"]) {
    assert.ok(!html.includes(needle), `index.html contains ${needle}`);
  }
});
