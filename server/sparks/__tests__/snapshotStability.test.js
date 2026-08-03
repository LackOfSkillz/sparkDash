import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SparkMonitor } from "../SparkMonitor.js";

/**
 * The broadcast path skips sending when a snapshot's JSON is byte-identical to the previous
 * one. Any field that changes on every call defeats that comparison, forcing a broadcast and a
 * full frontend re-render every tick — which looks like the page flashing once a second.
 *
 * This regression is easy to reintroduce: adding an age, a timestamp, or a counter to the
 * snapshot feels harmless in isolation. These tests make it fail loudly instead.
 */

function monitorFor(overrides = {}) {
  const spark = {
    id: "test-node",
    name: "test-node",
    lanIp: "192.168.1.200",
    ssh: { host: "192.168.1.200", user: "u", auth: "key" },
    llmPorts: [8888],
    role: "standalone",
    ...overrides,
  };
  const m = new SparkMonitor(spark);
  // Never start(): no timers, no SSH. Only the pure snapshot shape is under test.
  return m;
}

test("consecutive broadcast snapshots are byte-identical when nothing changed", () => {
  const m = monitorFor();
  const a = JSON.stringify(m.snapshot());
  const b = JSON.stringify(m.snapshot());
  assert.equal(a, b, "an unchanged node must serialise identically or the broadcast cache is dead");
});

test("the broadcast snapshot carries no per-call age or timestamp", () => {
  const m = monitorFor();
  const snap = m.snapshot();
  assert.equal("metricAgeMs" in snap, false, "a millisecond age changes every tick");
  assert.equal("lastSuccessfulCollectionAt" in snap, false, "an epoch changes on every collection");
  // The banded form is stable and therefore allowed.
  assert.ok(["fresh", "stale", "expired", "unknown"].includes(snap.metricFreshness));
});

test("still byte-identical after a successful collection is recorded", () => {
  const m = monitorFor();
  m._lastSuccessAt = { gpu: 1000, cpu: 1000, ram: 1000, network: 1000, storage: 1000, memory: 1000 };
  const a = JSON.stringify(m.snapshot());
  const b = JSON.stringify(m.snapshot());
  assert.equal(a, b);
});

test("the volatile fields are available on request, where dedup does not apply", () => {
  const m = monitorFor();
  m._lastSuccessAt = { gpu: Date.now() };
  const snap = m.snapshot({ includeVolatile: true });
  assert.ok("metricAgeMs" in snap, "the REST endpoint should still be able to report age");
  assert.ok("lastSuccessfulCollectionAt" in snap);
  assert.equal(typeof snap.metricAgeMs, "number");
});

test("liveness state is still exposed on the broadcast snapshot", () => {
  // These are booleans and a band — stable between ticks, so they belong in the broadcast.
  const m = monitorFor();
  const snap = m.snapshot();
  for (const k of ["online", "sshReachable", "llmReachable", "collectorDegraded", "metricFreshness"]) {
    assert.ok(k in snap, `${k} must be broadcast so the UI can distinguish degraded from offline`);
  }
});
