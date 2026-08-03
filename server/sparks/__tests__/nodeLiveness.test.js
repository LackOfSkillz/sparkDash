import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  LIVENESS_FAILURE_THRESHOLD,
  OFFLINE_GRACE_MS,
  applyLivenessObservation,
  createLivenessState,
  metricFreshness,
  shouldRetainMetrics,
} from "../nodeLiveness.js";

/**
 * What these pin is the distinction the old code could not make: a node that has stopped
 * answering SSH is not necessarily a node that is down. A benchmark produced nine false
 * offline episodes while both hosts held four days of unbroken uptime, so the bar for
 * declaring offline has to be sustained evidence, and recovery has to be immediate.
 */

const HEAD = { llmEligible: true };
const WORKER = { llmEligible: false };

/** Drive a state to online via one good probe. */
function onlineState(t = 1000) {
  const s = createLivenessState();
  applyLivenessObservation(s, { sshOk: true, llmOk: true, llmEligible: true, now: t });
  assert.equal(s.online, true, "precondition: state should start online");
  return s;
}

// ── Consecutive failures ───────────────────────────────────────────────────

test("one SSH failure does not mark a node offline", () => {
  const s = onlineState();
  const r = applyLivenessObservation(s, { sshOk: false, llmOk: null, ...WORKER, now: 6000 });
  assert.equal(s.online, true);
  assert.equal(s.consecutiveSshFailures, 1);
  assert.equal(r.changed, false);
});

test("two SSH failures do not mark a node offline", () => {
  const s = onlineState();
  applyLivenessObservation(s, { sshOk: false, llmOk: null, ...WORKER, now: 6000 });
  applyLivenessObservation(s, { sshOk: false, llmOk: null, ...WORKER, now: 11000 });
  assert.equal(s.online, true);
  assert.equal(s.consecutiveSshFailures, 2);
});

test("reaching the failure threshold is NOT enough while inside the grace window", () => {
  const s = onlineState(1000);
  for (let i = 1; i <= LIVENESS_FAILURE_THRESHOLD; i++) {
    applyLivenessObservation(s, { sshOk: false, llmOk: null, ...WORKER, now: 1000 + i * 5000 });
  }
  assert.ok(s.consecutiveSshFailures >= LIVENESS_FAILURE_THRESHOLD);
  assert.equal(s.online, true, "threshold met but last success is still recent");
});

test("offline requires BOTH the failure threshold and an expired grace window", () => {
  const s = onlineState(1000);
  let last;
  for (let i = 1; i <= 8; i++) {
    last = applyLivenessObservation(s, {
      sshOk: false, llmOk: null, ...WORKER, now: 1000 + i * 5000,
    });
  }
  // 8 * 5s = 40s since the last success, past the 30s grace.
  assert.ok(Date.now() >= 0);
  assert.equal(s.online, false);
  assert.equal(last.reason, "sustained-failure");
  assert.equal(last.changed, false, "already offline by the final observation");
});

test("a success resets the consecutive-failure count", () => {
  const s = onlineState();
  applyLivenessObservation(s, { sshOk: false, llmOk: null, ...WORKER, now: 6000 });
  applyLivenessObservation(s, { sshOk: false, llmOk: null, ...WORKER, now: 11000 });
  assert.equal(s.consecutiveSshFailures, 2);
  applyLivenessObservation(s, { sshOk: true, llmOk: null, ...WORKER, now: 16000 });
  assert.equal(s.consecutiveSshFailures, 0);
  assert.equal(s.online, true);
});

test("the grace window is at least 30 seconds", () => {
  assert.ok(OFFLINE_GRACE_MS >= 30000, `grace is ${OFFLINE_GRACE_MS}ms`);
  assert.ok(LIVENESS_FAILURE_THRESHOLD >= 3, `threshold is ${LIVENESS_FAILURE_THRESHOLD}`);
});

// ── Head LLM fallback ──────────────────────────────────────────────────────

test("head: SSH fails but vLLM answers -> online, SSH degraded", () => {
  const s = onlineState(1000);
  // Far beyond the grace window, so only the LLM signal can hold it up.
  const r = applyLivenessObservation(s, { sshOk: false, llmOk: true, ...HEAD, now: 500000 });
  assert.equal(s.online, true);
  assert.equal(r.reason, "llm-fallback");
  assert.equal(s.sshReachable, false);
  assert.equal(s.llmReachable, true);
  assert.equal(s.collectorDegraded, true, "up, but the collector is not delivering");
  assert.ok(s.counters.llmFallbackSaves > 0);
});

test("head: SSH and vLLM both fail -> stays online inside the grace window", () => {
  const s = onlineState(1000);
  const r = applyLivenessObservation(s, { sshOk: false, llmOk: false, ...HEAD, now: 11000 });
  assert.equal(s.online, true);
  assert.equal(r.reason, "within-grace");
});

test("head: SSH and vLLM failing past threshold and grace -> offline", () => {
  const s = onlineState(1000);
  for (let i = 1; i <= 8; i++) {
    applyLivenessObservation(s, { sshOk: false, llmOk: false, ...HEAD, now: 1000 + i * 5000 });
  }
  assert.equal(s.online, false);
  assert.equal(s.collectorDegraded, false, "offline is not 'degraded'");
});

test("a stale LLM reading cannot hold a head online — freshness is the caller's job", () => {
  // llmOk:false is what SparkMonitor passes once its last good probe aged out.
  const s = onlineState(1000);
  for (let i = 1; i <= 8; i++) {
    applyLivenessObservation(s, { sshOk: false, llmOk: false, ...HEAD, now: 1000 + i * 5000 });
  }
  assert.equal(s.online, false);
});

// ── Worker behaviour ───────────────────────────────────────────────────────

test("worker: has no LLM fallback even if an LLM signal is offered", () => {
  const s = onlineState(1000);
  // llmEligible false means the signal is ignored entirely — a worker hosts no endpoint.
  for (let i = 1; i <= 8; i++) {
    applyLivenessObservation(s, { sshOk: false, llmOk: true, ...WORKER, now: 1000 + i * 5000 });
  }
  assert.equal(s.online, false, "worker must not be propped up by someone else's endpoint");
  assert.equal(s.llmReachable, false);
});

test("worker: survives transient SSH failures", () => {
  const s = onlineState(1000);
  applyLivenessObservation(s, { sshOk: false, llmOk: null, ...WORKER, now: 6000 });
  applyLivenessObservation(s, { sshOk: false, llmOk: null, ...WORKER, now: 11000 });
  applyLivenessObservation(s, { sshOk: true, llmOk: null, ...WORKER, now: 16000 });
  assert.equal(s.online, true);
  assert.equal(s.counters.transitions, 1, "only the initial offline->online transition");
});

test("worker: goes offline after sustained failure", () => {
  const s = onlineState(1000);
  for (let i = 1; i <= 10; i++) {
    applyLivenessObservation(s, { sshOk: false, llmOk: null, ...WORKER, now: 1000 + i * 5000 });
  }
  assert.equal(s.online, false);
});

// ── Recovery ───────────────────────────────────────────────────────────────

test("an offline node recovers on a single successful probe", () => {
  const s = onlineState(1000);
  for (let i = 1; i <= 10; i++) {
    applyLivenessObservation(s, { sshOk: false, llmOk: null, ...WORKER, now: 1000 + i * 5000 });
  }
  assert.equal(s.online, false);
  const r = applyLivenessObservation(s, { sshOk: true, llmOk: null, ...WORKER, now: 100000 });
  assert.equal(s.online, true);
  assert.equal(r.changed, true);
  assert.equal(s.consecutiveSshFailures, 0);
  assert.equal(s.collectorDegraded, false);
});

test("a node that has never been reachable is not promoted to online by a failure", () => {
  const s = createLivenessState();
  applyLivenessObservation(s, { sshOk: false, llmOk: null, ...WORKER, now: 1000 });
  assert.equal(s.online, false);
});

test("transitions are counted, not every probe", () => {
  const s = createLivenessState();
  applyLivenessObservation(s, { sshOk: true, llmOk: null, ...WORKER, now: 1000 });
  applyLivenessObservation(s, { sshOk: true, llmOk: null, ...WORKER, now: 6000 });
  applyLivenessObservation(s, { sshOk: true, llmOk: null, ...WORKER, now: 11000 });
  assert.equal(s.counters.transitions, 1);
  assert.equal(s.counters.sshLivenessSuccesses, 3);
  assert.equal(s.counters.sshLivenessFailures, 0);
});

// ── Metric freshness ───────────────────────────────────────────────────────

test("freshness bands: fresh under 15s, stale to 60s, expired beyond", () => {
  const now = 1_000_000;
  assert.equal(metricFreshness(now - 5_000, now), "fresh");
  assert.equal(metricFreshness(now - 14_999, now), "fresh");
  assert.equal(metricFreshness(now - 20_000, now), "stale");
  assert.equal(metricFreshness(now - 60_000, now), "stale");
  assert.equal(metricFreshness(now - 60_001, now), "expired");
});

test("never-collected is 'unknown', which is not the same as stale", () => {
  assert.equal(metricFreshness(0, 1000), "unknown");
  assert.equal(metricFreshness(null, 1000), "unknown");
});

test("metrics are retained while the node is believed online, at any age", () => {
  assert.equal(shouldRetainMetrics(true, "fresh"), true);
  assert.equal(shouldRetainMetrics(true, "stale"), true);
  assert.equal(shouldRetainMetrics(true, "expired"), true, "a working node keeps its last reading");
});

test("an offline node drops expired readings rather than showing them as current", () => {
  assert.equal(shouldRetainMetrics(false, "fresh"), true);
  assert.equal(shouldRetainMetrics(false, "stale"), true);
  assert.equal(shouldRetainMetrics(false, "expired"), false);
  assert.equal(shouldRetainMetrics(false, "unknown"), false);
});
