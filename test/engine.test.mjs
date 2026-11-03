import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine, loadEmbedded, fixture } from "./engine-util.mjs";
import { validateSource } from "../lib/validate.js";

const ENGINE = loadEngine();
const EMBEDDED = loadEmbedded();

test("engine reproduces the embedded dashboard data exactly (parser/rules unchanged)", () => {
  const rebuilt = ENGINE.build(EMBEDDED.source, EMBEDDED.data.meta.today, EMBEDDED.data.meta.logo);
  assert.deepEqual(rebuilt, EMBEDDED.data);
});

test("real .xlsx import: projects, statuses, dates and multi-row updates are parsed", async () => {
  const res = await ENGINE.readWorkbook(fixture("sample.xlsx"), "sample.xlsx", Date.parse("2026-11-03T05:00:00Z"));
  const byName = Object.fromEntries(res.source.projects.map((p) => [p.name, p]));
  assert.equal(res.source.sheetName, "Sheet1");
  assert.equal(res.source.projects.length, 6);
  assert.equal(byName["Warehouse Scanner Rollout"].expectedEndDate, "2026-12-15");
  assert.equal(byName["Warehouse Scanner Rollout"].mappedStatus, "in_progress");
  assert.equal(byName["Warehouse Scanner Rollout"].updates.length, 2, "continuation row attaches as a second update");
  assert.equal(byName["HR Portal Revamp"].mappedStatus, "on_hold");
  assert.equal(byName["Dealer Credit Automation"].expectedEndKind, "tbs");
  assert.equal(byName["Data Lake"].expectedEndKind, "ongoing");
  assert.equal(byName["Plant Wi-Fi Upgrade"].mappedStatus, "completed");
  assert.deepEqual(byName["Dealer Credit Automation"].department, "Sales, Finance");
  assert.equal(byName["Secret Hidden Project"].sourceHidden, true, "hidden Excel rows are still flagged for review");
  assert.ok(byName["Secret Hidden Project"].reviewFlags.some((f) => f.code === "hidden_in_source"));
});

test("dashboard data builds from a real import (KPIs and charts inputs present)", async () => {
  const res = await ENGINE.readWorkbook(fixture("sample.xlsx"), "sample.xlsx", Date.parse("2026-11-03T05:00:00Z"));
  const data = ENGINE.build(res.source, "2026-11-03", "data:,");
  assert.equal(data.projects.length, 6);
  assert.ok(data.stats.kpis && data.stats.statusDistribution.length && data.gantt);
});

test("existing validation rules still reject bad files", async () => {
  await assert.rejects(() => ENGINE.readWorkbook(new Uint8Array([1, 2, 3, 4]), "x.xlsx", 0), /zip/i);
  await assert.rejects(() => ENGINE.readWorkbook(fixture("bad-columns.xlsx"), "bad.xlsx", 0), /expected columns|Missing required|No sheet/i);
});

test("server validator accepts everything the real parser emits (real import + embedded source)", async () => {
  for (const name of ["sample.xlsx", "sample-v2.xlsx"]) {
    const res = await ENGINE.readWorkbook(fixture(name), name, Date.parse("2026-11-03T05:00:00Z"));
    assert.doesNotThrow(() => validateSource(JSON.parse(JSON.stringify(res.source))), name);
  }
  assert.doesNotThrow(() => validateSource(JSON.parse(JSON.stringify(EMBEDDED.source))));
});
