/**
 * Node liveness state machine.
 *
 * The old rule was: one SSH probe, and if it had been failing for ten seconds the node is
 * offline. On a wireless management path that is not a liveness test, it is a link-quality
 * test — a benchmark run produced nine false-offline episodes while both hosts held four days
 * of unbroken uptime, and at one point the head was drawn as "Host unreachable" on the same
 * page that showed its own vLLM endpoint answering.
 *
 * The rules here separate three questions that the old code answered with one bit:
 *   - is the host reachable at all
 *   - is the SSH collector working
 *   - are the metrics we are drawing still current
 *
 * A node goes offline only when the evidence for it is sustained: a threshold number of
 * consecutive SSH failures AND no successful probe inside the grace window AND, for a head
 * with LLM monitoring, no answering model endpoint.
 *
 * Pure functions and a plain state object — no timers, no I/O — so the policy can be tested
 * without a network.
 */

/** Consecutive failed SSH liveness probes required before offline is even considered. */
export const LIVENESS_FAILURE_THRESHOLD = 3;
/** No successful probe within this window is also required before declaring offline. */
export const OFFLINE_GRACE_MS = 30000;
/** One good probe is enough to come back. Recovery should be fast; going offline should not. */
export const RECOVERY_SUCCESS_THRESHOLD = 1;

/** Metric age bands, reported to the UI as freshness rather than as truth/absence. */
export const METRIC_FRESH_MS = 15000;
export const METRIC_STALE_MS = 60000;

/** @typedef {"fresh"|"stale"|"expired"|"unknown"} MetricFreshness */

export function createLivenessState() {
  return {
    online: false,
    /** Last successful SSH liveness probe, epoch ms. 0 = never. */
    lastSshOkAt: 0,
    /** Last time the LLM endpoint answered, epoch ms. 0 = never. */
    lastLlmOkAt: 0,
    consecutiveSshFailures: 0,
    consecutiveSshSuccesses: 0,
    sshReachable: false,
    llmReachable: false,
    /** True when the host is believed up but SSH collection is not working. */
    collectorDegraded: false,
    counters: {
      sshLivenessSuccesses: 0,
      sshLivenessFailures: 0,
      llmFallbackSaves: 0, // times the LLM endpoint alone kept a head online
      pollsSkippedInFlight: 0,
      transitions: 0,
    },
  };
}

/**
 * Fold one liveness observation into the state.
 *
 * @param {ReturnType<typeof createLivenessState>} state Mutated in place.
 * @param {object} obs
 * @param {boolean} obs.sshOk         Did the SSH liveness probe succeed this cycle.
 * @param {boolean|null} obs.llmOk    Did the model endpoint answer; null when not applicable.
 * @param {boolean} obs.llmEligible   Head-with-LLM-monitoring may use the LLM fallback.
 * @param {number} obs.now            Epoch ms.
 * @param {object} [policy]
 * @returns {{changed: boolean, from: boolean, to: boolean, reason: string}}
 */
export function applyLivenessObservation(state, obs, policy = {}) {
  const threshold = policy.failureThreshold ?? LIVENESS_FAILURE_THRESHOLD;
  const graceMs = policy.offlineGraceMs ?? OFFLINE_GRACE_MS;
  const recoveryNeeded = policy.recoverySuccesses ?? RECOVERY_SUCCESS_THRESHOLD;

  const { sshOk, llmOk, llmEligible, now } = obs;
  const was = state.online;

  if (sshOk) {
    state.counters.sshLivenessSuccesses++;
    state.consecutiveSshFailures = 0;
    state.consecutiveSshSuccesses++;
    state.lastSshOkAt = now;
    state.sshReachable = true;
  } else {
    state.counters.sshLivenessFailures++;
    state.consecutiveSshSuccesses = 0;
    state.consecutiveSshFailures++;
    state.sshReachable = false;
  }

  // The LLM signal is only meaningful for a head with monitoring on. A worker hosts no
  // endpoint of its own, so its absence says nothing about the worker.
  const llmUsable = llmEligible && llmOk === true;
  if (llmUsable) state.lastLlmOkAt = now;
  state.llmReachable = llmEligible ? llmOk === true : false;

  let reason;
  if (sshOk) {
    reason = "ssh-ok";
    state.online = state.consecutiveSshSuccesses >= recoveryNeeded ? true : state.online;
  } else if (llmUsable) {
    // The host is demonstrably serving traffic; only the SSH collector is broken.
    reason = "llm-fallback";
    if (!was) state.counters.llmFallbackSaves++;
    else state.counters.llmFallbackSaves++;
    state.online = true;
  } else {
    const withinGrace = state.lastSshOkAt > 0 && now - state.lastSshOkAt <= graceMs;
    const enoughFailures = state.consecutiveSshFailures >= threshold;
    if (enoughFailures && !withinGrace) {
      reason = "sustained-failure";
      state.online = false;
    } else {
      reason = withinGrace ? "within-grace" : "below-threshold";
      // Never promote to online on a failure; only hold an existing online state.
      state.online = state.lastSshOkAt > 0 ? state.online : false;
    }
  }

  // Degraded means: we believe the host is up, but SSH is not delivering metrics.
  state.collectorDegraded = state.online && !state.sshReachable;

  const changed = was !== state.online;
  if (changed) state.counters.transitions++;
  return { changed, from: was, to: state.online, reason };
}

/**
 * Classify how old a metric is. `unknown` when nothing has ever been collected, which is
 * different from stale — the UI must not imply a value it has never had.
 * @param {number} lastSuccessAt epoch ms, 0/null when never
 * @param {number} now
 * @returns {MetricFreshness}
 */
export function metricFreshness(lastSuccessAt, now, policy = {}) {
  const freshMs = policy.freshMs ?? METRIC_FRESH_MS;
  const staleMs = policy.staleMs ?? METRIC_STALE_MS;
  if (!lastSuccessAt) return "unknown";
  const age = now - lastSuccessAt;
  if (age < freshMs) return "fresh";
  if (age <= staleMs) return "stale";
  return "expired";
}

/**
 * Should the last known metrics still be shown?
 *
 * Retained while the node is believed online, however stale — showing the last real reading
 * with an age beats blanking a working cluster because one probe timed out. Once the node is
 * genuinely offline, expired values are dropped rather than left to look current.
 */
export function shouldRetainMetrics(online, freshness) {
  if (online) return true;
  return freshness === "fresh" || freshness === "stale";
}
