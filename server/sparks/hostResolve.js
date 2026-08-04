/**
 * Which address do we reach a Spark on right now?
 *
 * A Spark can be reachable two ways: over the local network, and over Tailscale
 * when the dashboard is somewhere else. The rule is LAN FIRST, Tailscale as
 * fallback — the LAN path is faster and does not depend on a third-party mesh
 * being up, so it should never be abandoned lightly.
 *
 * THE POLICY: SETTLE, THEN STAY, AND ONLY RE-PROBE ON LOSS.
 *
 * Try the LAN. If it answers, stay on it. If it does not, move to Tailscale and
 * stay there — indefinitely, with no periodic re-probing. The only thing that
 * sends us back to the LAN is the address we are ON failing.
 *
 * The alternative — re-testing the LAN on a timer — was the first version and it
 * was wrong for how this is actually used. A machine moves between home and
 * office about twice a day, so a 60s re-probe meant ~700 deliberately doomed
 * 5-second SSH attempts per node per day to discover something that changes
 * twice. It also cannot be cheap: SSH_CONNECT_TIMEOUT is 5s and the liveness
 * poll runs every 5s, so every re-probe risks overlapping a poll, and skipped
 * polls slow the three-consecutive-failure countdown to "offline". A feature
 * meant to improve reachability would have made outage detection slower.
 *
 * Losing the connection is the honest signal that the network changed, and it
 * arrives exactly when it matters. Nothing else needs to poll for it.
 *
 * Consequence worth knowing: once settled on Tailscale, that is where it stays
 * even back on the home network, until Tailscale itself drops. In practice
 * Tailscale routes peers on the same LAN directly, so the cost is negligible —
 * and a dashboard restart re-probes from the LAN, since this state is in memory.
 *
 * WHAT THIS MODULE DOES NOT DO.
 *
 * It never resolves an address for Wake-on-LAN. WoL is an L2 broadcast to
 * x.y.z.255; Tailscale is L3 with no broadcast domain, so a magic packet sent to
 * a 100.x address is meaningless. Those call sites read `spark.lanIp` literally
 * and must keep doing so.
 */

/**
 * Consecutive failures on the settled address before we go back to the primary.
 *
 * One failed command is NOT "the connection is lost". A single SSH can fail for
 * reasons that have nothing to do with the path: a slow remote command, a
 * momentary hiccup, a timeout inherited from an earlier attempt in the same
 * call. Treating any one of those as a network change made the resolver thrash
 * — settle on the fallback, blip, go back to the primary, burn a 5s connect
 * timeout, settle again — which is what a naive version of this actually did.
 *
 * Three mirrors LIVENESS_FAILURE_THRESHOLD, so an address is abandoned on the
 * same evidence a node is declared offline on.
 */
export const SETTLED_FAILURE_THRESHOLD = 3;

/**
 * @typedef {object} HostState
 * @property {"primary"|"fallback"} active
 * @property {number} lastPrimaryFailureAt
 * @property {number} failoverCount
 * @property {number} lastSuccessAt
 * @property {number} settledFailures consecutive failures on the active address
 */

/** @type {Map<string, HostState>} sparkId → state */
const state = new Map();

function stateFor(sparkId) {
  let s = state.get(sparkId);
  if (!s) {
    s = {
      active: "primary", lastPrimaryFailureAt: 0, failoverCount: 0,
      lastSuccessAt: 0, settledFailures: 0,
    };
    state.set(sparkId, s);
  }
  return s;
}

const clean = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * The two candidate addresses for a Spark, in preference order.
 *
 * `ssh.host` wins over `lanIp` for the primary because that is the existing
 * behaviour everywhere in the codebase; changing it here would silently move
 * every Spark whose ssh.host is a DNS name.
 */
export function hostCandidates(spark) {
  if (!spark || typeof spark !== "object") return { primary: "", fallback: "" };
  const primary = clean(spark.ssh?.host) || clean(spark.lanIp);
  const fallback = clean(spark.tailscaleIp);
  return { primary, fallback };
}

/**
 * Address to use for the next attempt.
 *
 * Synchronous on purpose: `llmProbeHost` is called from constructors and hot
 * paths that cannot await. The decision comes from remembered outcomes, not
 * from probing inline.
 */
export function resolveHost(spark, now = Date.now()) {
  const { primary, fallback } = hostCandidates(spark);
  if (!fallback) return primary;
  if (!primary) return fallback;

  const s = stateFor(spark.id);
  // Settled means settled. No timer re-offers the primary; the only route back
  // is `reportFailure` on the address currently in use.
  void now;
  return s.active === "primary" ? primary : fallback;
}

/** True when `host` is this Spark's fallback address. */
export function isFallbackHost(spark, host) {
  const { fallback } = hostCandidates(spark);
  return !!fallback && clean(host) === fallback;
}

/**
 * Should a failed attempt on `host` be retried on the SAME address first?
 *
 * Measured on this deployment: about 8% of storage polls fail over Tailscale
 * while the link itself is continuously up — 20 consecutive round trips showed
 * median 756ms, p90 841ms, zero failures, and the exact batched script the
 * dashboard sends succeeded 8 times out of 8 by hand. So an isolated failure is
 * contention, not a network change, and one immediate retry at ~800ms absorbs
 * it: an 8% independent failure rate becomes about 0.6%.
 *
 * The retry is allowed ONLY when this address has no run of failures behind it.
 * That matters for how fast a genuine outage is noticed: without the guard, a
 * dead host would pay a doubled timeout on EVERY call, and with a second address
 * to try as well that is four connect timeouts per poll. With it, a host going
 * down pays one extra attempt once, and then every later call fails at the
 * normal speed.
 */
export function shouldRetryTransient(spark, host) {
  const { primary, fallback } = hostCandidates(spark);
  if (!spark?.id) return false;
  const h = clean(host);
  if (h !== primary && h !== fallback) return false;
  const s = state.get(spark.id);
  if (!s) return true; // no history: a first failure is as likely to be a blip
  const activeHost = s.active === "fallback" ? fallback : primary;
  return h === activeHost && s.settledFailures === 0;
}

/**
 * Record that an attempt on `host` failed, and say whether a retry on the other
 * address is worth making. Returns the address to retry on, or null.
 *
 * Only a failure on the PRIMARY earns a retry. A failure on the fallback means
 * both paths are down, which is a genuine outage and must be reported as one
 * rather than hidden behind more attempts.
 */
export function reportFailure(spark, host, now = Date.now()) {
  const { primary, fallback } = hostCandidates(spark);
  if (!spark?.id || !fallback || !primary) return null;
  const s = stateFor(spark.id);

  if (clean(host) === primary) {
    // A primary failure always moves to the fallback immediately: there is
    // another address to try right now, so trying it costs one attempt and
    // answers the question. Counting the transition only when we were actually
    // on the primary keeps concurrent pollers from inflating it.
    if (s.active === "primary") {
      s.failoverCount++;
      s.settledFailures = 0;
    }
    s.active = "fallback";
    s.lastPrimaryFailureAt = now;
    return fallback;
  }

  // The address we settled on failed. This is the ONLY re-probe trigger — but
  // it takes SETTLED_FAILURE_THRESHOLD consecutive failures, because one failed
  // command is not a lost connection, and treating it as one made this thrash.
  if (clean(host) === fallback) {
    s.settledFailures++;
    if (s.settledFailures >= SETTLED_FAILURE_THRESHOLD) {
      s.active = "primary";
      s.lastPrimaryFailureAt = 0;
      s.settledFailures = 0;
    }
  }
  return null;
}

/** Record that an attempt on `host` succeeded. */
export function reportSuccess(spark, host, now = Date.now()) {
  const { primary, fallback } = hostCandidates(spark);
  if (!spark?.id || !fallback || !primary) return;
  const s = stateFor(spark.id);
  s.lastSuccessAt = now;
  // Any success on the address in use clears the run of failures toward
  // abandoning it — the threshold counts CONSECUTIVE failures.
  s.settledFailures = 0;
  s.active = clean(host) === fallback ? "fallback" : "primary";
  if (s.active === "primary") s.lastPrimaryFailureAt = 0;
}

/** Diagnostics for the liveness endpoint. Never a credential, never a command. */
export function hostDiagnostics(spark) {
  const { primary, fallback } = hostCandidates(spark);
  const s = state.get(spark?.id) ?? null;
  return {
    primary,
    fallback: fallback || null,
    active: fallback ? (s?.active ?? "primary") : "primary",
    usingFallback: Boolean(fallback) && s?.active === "fallback",
    failoverCount: s?.failoverCount ?? 0,
    lastPrimaryFailureAt: s?.lastPrimaryFailureAt || null,
    lastSuccessAt: s?.lastSuccessAt || null,
  };
}

/** Test seam. */
export function _resetHostState() {
  state.clear();
}
