import { test } from "node:test";
import { strict as assert } from "node:assert";

/**
 * The cluster overview's aggregate arithmetic, ported here as executable specification.
 *
 * The frontend module is TypeScript and this suite is the repository's plain node:test runner,
 * so the reference implementations below mirror src/components/OverviewPage/clusterModel.ts.
 * What is being pinned is the CONTRACT that made these worth writing: a value that was never
 * reported must never be presented as zero, and an average must never be divided by the number
 * of nodes we hoped would report.
 */

function sumOrNull(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0);
}

function meanOrNull(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

test("sumOrNull: missing values are omitted, not counted as zero", () => {
  assert.equal(sumOrNull([100020, 100020]), 200040);
  assert.equal(sumOrNull([100020, null]), 100020, "a null node must not add 0");
  assert.equal(sumOrNull([100020, undefined]), 100020);
  assert.equal(sumOrNull([]), null, "nothing reported must be null, never 0");
  assert.equal(sumOrNull([null, undefined]), null);
});

test("sumOrNull: NaN and Infinity are rejected rather than poisoning the total", () => {
  assert.equal(sumOrNull([10, NaN]), 10);
  assert.equal(sumOrNull([10, Infinity]), 10);
  assert.equal(sumOrNull([NaN]), null);
});

test("meanOrNull: divides by reporting nodes only", () => {
  // Two nodes at 46 and 44 average 45 — not 30, which is what dividing by an
  // expected three would give.
  assert.equal(meanOrNull([46, 44]), 45);
  assert.equal(meanOrNull([46, 44, null]), 45, "a non-reporting node must not drag the mean");
  assert.equal(meanOrNull([]), null);
});

test("meanOrNull: a genuine zero still counts", () => {
  // 0% GPU usage is a real measurement and must not be confused with "not reported".
  assert.equal(meanOrNull([0, 0]), 0);
  assert.equal(meanOrNull([0, 100]), 50);
});

test("aggregate shape: totals and averages behave together on a realistic pair", () => {
  const nodes = [
    { vram: { used: 100020, total: 124610 }, ram: { used: 112806, total: 124610 }, temp: 46, usage: 0, power: 10.36 },
    { vram: { used: 100020, total: 124610 }, ram: { used: 111990, total: 124610 }, temp: 44, usage: 0, power: 11.46 },
  ];
  assert.equal(sumOrNull(nodes.map((n) => n.vram.used)), 200040);
  assert.equal(sumOrNull(nodes.map((n) => n.vram.total)), 249220);
  assert.equal(sumOrNull(nodes.map((n) => n.ram.used)), 224796);
  assert.equal(meanOrNull(nodes.map((n) => n.temp)), 45);
  assert.equal(meanOrNull(nodes.map((n) => n.usage)), 0);
  assert.equal(Number(sumOrNull(nodes.map((n) => n.power)).toFixed(2)), 21.82);
});

test("aggregate shape: one node dark yields a partial total, not a halved cluster", () => {
  const vramUsed = sumOrNull([100020, null]);
  const vramTotal = sumOrNull([124610, null]);
  assert.equal(vramUsed, 100020);
  assert.equal(vramTotal, 124610);
  // The caller is expected to mark this partial by comparing reporting vs expected.
  const reporting = [100020, null].filter((v) => typeof v === "number").length;
  assert.equal(reporting, 1);
  assert.ok(reporting < 2, "UI must be able to detect and label a partial aggregate");
});

test("percentages are never summed across nodes", () => {
  // Two nodes at 90% RAM is still 90% cluster-wide, not 180%. Percentages must be
  // recomputed from summed used/total, or averaged — never added.
  const used = sumOrNull([112806, 111990]);
  const total = sumOrNull([124610, 124610]);
  const pct = (used / total) * 100;
  assert.ok(pct > 89 && pct < 91, `expected ~90%, got ${pct}`);
  assert.ok(pct <= 100, "a cluster percentage must never exceed 100");
});

test("uptime formatting comes from node-reported seconds", () => {
  const fmt = (s) => {
    if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return "—";
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };
  assert.equal(fmt(357319), "4d 3h");
  assert.equal(fmt(7260), "2h 1m");
  assert.equal(fmt(300), "5m");
  assert.equal(fmt(null), "—", "absent uptime must render as a dash, not 0m");
  assert.equal(fmt(0), "—");
});

// ---------------------------------------------------------------------------
// Cluster topology stability.
//
// The overview keys its entire layout off findHead(): no head means no cluster, which unmounts
// the summary and inference panels and reflows the node cards from two columns to three. That
// used to depend on a live LLM probe, so one timed-out HTTP request over a marginal link made
// the whole page shrink and spring back. Topology is configuration, not a measurement.
//
// Mirrors src/components/OverviewPage/clusterModel.ts. The authoritative check for this fix was
// a browser reproduction that injected the failing snapshot and compared rendered card widths
// (695px stable, versus 460px before the fix).
// ---------------------------------------------------------------------------

function resolveRole(s) {
  return s.role || (s.workerNode ? "worker" : "standalone");
}
function activeLlmMirror(s) {
  const arr = s?.metrics?.llm;
  return Array.isArray(arr) ? arr.find((l) => l.available) ?? null : null;
}
function headStandaloneMirror(sparks) {
  if (!sparks.some((s) => resolveRole(s) === "worker")) return null;
  const standalones = sparks.filter((s) => resolveRole(s) === "standalone");
  const serving = standalones.find((s) => activeLlmMirror(s));
  if (serving) return serving;
  return standalones.length === 1 ? standalones[0] : null;
}

const withLlm = (id, available) => ({
  id, role: "standalone", metrics: { llm: available === null ? [] : [{ available }] },
});
const worker = { id: "w1", role: "worker", metrics: { llm: [] } };

test("topology: a sole standalone beside a worker is the head even with no LLM reading", () => {
  for (const llm of [true, false, null]) {
    const sparks = [withLlm("h1", llm), worker];
    const head = headStandaloneMirror(sparks);
    assert.equal(head?.id, "h1", `head must not depend on the probe (llm=${String(llm)})`);
  }
});

test("topology: with several standalones the serving one still wins", () => {
  const sparks = [withLlm("a", false), withLlm("b", true), worker];
  assert.equal(headStandaloneMirror(sparks)?.id, "b", "a live endpoint disambiguates");
});

test("topology: several standalones and none serving is genuinely ambiguous", () => {
  const sparks = [withLlm("a", false), withLlm("b", false), worker];
  assert.equal(headStandaloneMirror(sparks), null, "guessing between two would be worse");
});

test("topology: a lone standalone with no worker is not a head", () => {
  assert.equal(headStandaloneMirror([withLlm("solo", true)]), null);
});

test("topology: the verdict is identical across a probe flapping", () => {
  // The exact sequence that made the page shrink and spring back.
  const seq = [true, false, false, true, null, true];
  const ids = seq.map((v) => headStandaloneMirror([withLlm("h1", v), worker])?.id ?? null);
  assert.deepEqual(ids, ids.map(() => "h1"), "layout must not change as the probe flaps");
});
