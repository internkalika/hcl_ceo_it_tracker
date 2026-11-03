import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fake from "./fake-blob.mjs";
import { SECRETS, setEnv, startServer } from "./harness.mjs";

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require("playwright")); } catch { /* browser tests are skipped without Playwright */ }
const skip = chromium ? false : "Playwright is not installed";
const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => path.join(here, "fixtures", n);
const SHOTS = process.env.UI_SHOTS_DIR || "";

let srv, browser;
before(async () => {
  if (!chromium) return;
  setEnv("preview"); fake.reset();
  srv = await startServer();
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await srv?.close(); });

const IGNORED = /Failed to load resource.*(401|404|429|503)/; // statuses these tests trigger on purpose (nothing published, wrong passphrase, lockout)
async function newPage(ctx, errs) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !IGNORED.test(m.text())) errs.push("console: " + m.text()); });
  return page;
}
const settle = (page) => page.waitForSelector("#view h1", { timeout: 10000 });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: false }); };

test("fallback: with nothing published the page shows its built-in data (offline-safe) and every route works", { skip }, async () => {
  const errs = [];
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await newPage(ctx, errs);
  await page.goto(srv.base + "/");
  await settle(page);
  assert.match(await page.textContent("#snap"), /Built from Book_1\.xlsx/);
  assert.match(await page.textContent("#status-line"), /17 projects/);
  assert.ok(await page.locator(".kpi").count() >= 5, "KPI tiles render");
  assert.ok(await page.locator("#view svg").count() >= 1, "charts render");
  await shot(page, "01-dashboard-fallback");

  // every existing route, filters, detail, calendar/gantt, help
  for (const hash of ["#/projects", "#/projects?status=in_progress", "#/projects?q=dealer", "#/timeline", "#/help"]) {
    await page.goto(srv.base + "/" + hash); await page.reload(); await settle(page);
    assert.ok((await page.textContent("#view")).length > 50, hash);
  }
  await page.goto(srv.base + "/#/projects?q=dealer"); await page.reload(); await settle(page);
  assert.ok(await page.locator(".pcard").count() >= 1, "search filter returns cards");
  await page.locator(".pcard a.stretch").first().click();
  await page.waitForSelector("#view h1");
  assert.match(page.url(), /#\/projects\/p\d+/);
  // theme toggle
  await page.click("#theme-btn");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page.click("#theme-btn");
  // Excel export still works (also proves the CSP in vercel.json does not block downloads)
  await page.goto(srv.base + "/#/projects"); await page.reload(); await settle(page);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#dl-all")]);
  assert.match(dl.suggestedFilename(), /\.xlsx$/i);
  assert.deepEqual(errs, []);
  await ctx.close();
});

test("publisher flow: import -> sign in (wrong then right) -> publish; anonymous viewers see it; history and restore", { skip }, async () => {
  const errs = [];
  const pubCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await newPage(pubCtx, errs);
  await page.goto(srv.base + "/"); await settle(page);

  // Existing import flow, unchanged, now offering Publish
  await page.setInputFiles("#import-file", fx("sample.xlsx"));
  await page.waitForSelector("#dlg-content h2.ok");
  const dlg = await page.textContent("#dlg-content");
  assert.match(dlg, /Dashboard updated/);
  assert.match(dlg, /6 projects/);
  assert.match(dlg, /preview in this browser only/i);
  await shot(page, "02-import-dialog-with-publish");
  assert.match(await page.textContent("#snap"), /not published/);

  // Publish -> not signed in -> sign-in dialog; wrong passphrase refused
  await page.click("#publish-now");
  await page.waitForSelector("#pub-pass");
  await shot(page, "03-signin-dialog");
  await page.fill("#pub-pass", "definitely-wrong");
  await page.press("#pub-pass", "Enter");
  await page.waitForSelector("#dlg-content p.bad");
  assert.match(await page.textContent("#dlg-content"), /not correct/);
  assert.equal(await page.inputValue("#pub-pass"), "", "passphrase field is cleared");

  // Right passphrase -> published
  await page.fill("#pub-pass", SECRETS.publish);
  await page.press("#pub-pass", "Enter");
  await page.waitForSelector("#dlg-content h2.ok");
  assert.match(await page.textContent("#dlg-content"), /Published[\s\S]*6 projects[\s\S]*live for everyone/);
  await shot(page, "04-published");
  assert.match(await page.textContent("#snap"), /last published .* IST/);
  assert.match(await page.textContent("#status-line"), /published .* IST/);
  assert.ok(!(await page.textContent("#snap")).includes("not published"));
  await page.click("[data-close]");

  // Anonymous viewer in a brand-new browser profile: sees the published data with no login
  const viewCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const viewer = await newPage(viewCtx, errs);
  await viewer.goto(srv.base + "/"); await settle(viewer);
  assert.match(await viewer.textContent("#status-line"), /6 projects/);
  assert.match(await viewer.textContent("#snap"), /Published data from sample\.xlsx/);
  await viewer.goto(srv.base + "/#/projects"); await viewer.reload(); await settle(viewer);
  assert.match(await viewer.textContent("#view"), /Warehouse Scanner Rollout/);
  assert.equal(await viewer.locator("#pub-pass").count(), 0, "viewers are never asked to sign in");
  await shot(viewer, "05-viewer-sees-published");

  // Publish a second workbook, then restore the first from Publisher tools
  await page.setInputFiles("#import-file", fx("sample-v2.xlsx"));
  await page.waitForSelector("#dlg-content h2.ok");
  await page.click("#publish-now");            // already signed in: goes straight through
  await page.waitForSelector("#dlg-content h2.ok");
  assert.match(await page.textContent("#dlg-content"), /2 projects/);
  await page.click("[data-close]");
  await viewer.reload(); await settle(viewer);
  assert.match(await viewer.textContent("#status-line"), /2 projects/, "viewer sees the new publish after a reload, no redeploy");

  await page.click("#pub-tools");
  await page.waitForSelector("ul.hist li");
  assert.equal(await page.locator("ul.hist li").count(), 2);
  assert.equal(await page.locator("ul.hist li .tag").count(), 1, "exactly one version is marked Live");
  await shot(page, "06-publisher-tools");
  await page.click("[data-restore]");
  await page.waitForFunction(() => document.querySelectorAll("ul.hist li").length === 3);
  assert.match(await page.textContent("#status-line"), /6 projects/, "the publisher's own page switched to the restored data");
  await page.click("[data-close]");
  await viewer.reload(); await settle(viewer);
  assert.match(await viewer.textContent("#status-line"), /6 projects/, "viewer sees the restored version");

  // Cookie hardening as seen by the browser, and nothing sensitive reachable from page scripts
  const cookie = (await pubCtx.cookies()).find((c) => c.name === "it_tracker_session");
  assert.ok(cookie, "session cookie set");
  assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.sameSite, "Strict");
  assert.ok(cookie.expires - Date.now() / 1000 <= 1800 + 5, "short-lived");
  const exposed = await page.evaluate(() => JSON.stringify({ c: document.cookie, ls: { ...localStorage }, ss: { ...sessionStorage }, html: document.documentElement.outerHTML }));
  assert.ok(!exposed.includes("it_tracker_session"), "HttpOnly cookie is invisible to scripts");
  for (const secret of [SECRETS.publish, SECRETS.session, "vercel_blob_rw_", "AbCdEfGhIjKlMnOpQrStUvWxYz"]) assert.ok(!exposed.includes(secret), "page leaks " + secret.slice(0, 6));
  const net = JSON.stringify(srv.log);
  for (const secret of [SECRETS.publish, SECRETS.session, "vercel_blob_rw_"]) assert.ok(!net.includes(secret), "network leaks " + secret.slice(0, 6));

  // Sign out invalidates further publishing from this browser
  await page.click("#pub-tools"); await page.waitForSelector("#pub-signout"); await page.click("#pub-signout");
  await page.setInputFiles("#import-file", fx("sample-v2.xlsx"));
  await page.waitForSelector("#dlg-content h2.ok");
  await page.click("#publish-now");
  await page.waitForSelector("#pub-pass");
  assert.deepEqual(errs, []);
  await pubCtx.close(); await viewCtx.close();
});

test("lockout and expired sign-in are handled with clear messages in the UI", { skip }, async () => {
  const errs = [];
  fake.reset();
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-vercel-forwarded-for": "198.51.100.77" } });
  const page = await newPage(ctx, errs);
  await page.goto(srv.base + "/"); await settle(page);
  await page.setInputFiles("#import-file", fx("sample.xlsx"));
  await page.waitForSelector("#publish-now"); await page.click("#publish-now");
  for (let i = 0; i < 5; i++) { await page.waitForSelector("#pub-pass"); await page.fill("#pub-pass", "wrong" + i); await page.press("#pub-pass", "Enter"); await page.waitForSelector("#dlg-content p.bad"); }
  await page.waitForSelector("#pub-pass"); await page.fill("#pub-pass", SECRETS.publish); await page.press("#pub-pass", "Enter");
  await page.waitForFunction(() => /Too many failed attempts/.test(document.querySelector("#dlg-content").textContent));
  assert.deepEqual(errs, []);
  await ctx.close();
});

test("offline / API failure: the dashboard still renders from its built-in data", { skip }, async () => {
  const errs = [];
  fake.reset();
  const ctx = await browser.newContext();
  await ctx.route("**/api/data*", (r) => r.abort());
  const page = await newPage(ctx, errs);
  await page.goto(srv.base + "/"); await settle(page);
  assert.match(await page.textContent("#snap"), /Built from Book_1\.xlsx/);
  assert.match(await page.textContent("#status-line"), /17 projects/);
  await ctx.close();
  // a server that returns garbage must not break the page either
  const ctx2 = await browser.newContext();
  await ctx2.route("**/api/data*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schemaVersion: 1, version: "v", publishedAt: "2026-01-01T00:00:00.000Z", source: { projects: [{ bogus: true }] } }) }));
  const p2 = await newPage(ctx2, []);
  await p2.goto(srv.base + "/"); await settle(p2);
  assert.match(await p2.textContent("#status-line"), /17 projects/, "unusable published data falls back instead of breaking");
  await ctx2.close();
});

test("a stale local preview never hides newer published data, but a newer local preview is kept", { skip }, async () => {
  const errs = [];
  fake.reset();
  const ctx = await browser.newContext();
  const page = await newPage(ctx, errs);
  await page.goto(srv.base + "/"); await settle(page);
  // Old-style local import from "last month" (before any publish)
  await page.setInputFiles("#import-file", fx("sample-v2.xlsx"));
  await page.waitForSelector("#dlg-content h2.ok");
  await page.evaluate(() => { const k = "hero-it-tracker-import-v1"; const o = JSON.parse(localStorage.getItem(k)); o.at = Date.now() - 30 * 864e5; localStorage.setItem(k, JSON.stringify(o)); });
  // Someone else publishes the 6-project workbook
  const other = await browser.newContext(); const op = await newPage(other, errs);
  await op.goto(srv.base + "/"); await settle(op);
  await op.setInputFiles("#import-file", fx("sample.xlsx")); await op.waitForSelector("#publish-now"); await op.click("#publish-now");
  await op.waitForSelector("#pub-pass"); await op.fill("#pub-pass", SECRETS.publish); await op.press("#pub-pass", "Enter");
  await op.waitForSelector("#dlg-content h2.ok");
  await page.reload(); await settle(page);
  assert.match(await page.textContent("#status-line"), /6 projects/, "older local preview yields to the published data");
  // A newer local preview wins and is labelled as unpublished
  await page.setInputFiles("#import-file", fx("sample-v2.xlsx"));
  await page.waitForSelector("#dlg-content h2.ok");
  await page.reload(); await settle(page);
  assert.match(await page.textContent("#status-line"), /2 projects/);
  assert.match(await page.textContent("#snap"), /not published[\s\S]*Go back to the published data/);
  await page.click("#reset"); await settle(page);
  assert.match(await page.textContent("#status-line"), /6 projects/);
  assert.deepEqual(errs, []);
  await ctx.close(); await other.close();
});
