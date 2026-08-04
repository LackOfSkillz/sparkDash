/**
 * Which address do we reach a Spark on right now?
 *
 * A Spark can be reachable two ways: over the local network, and over Tailscale
 * when the dashboard is somewhere else. The rule is LAN FIRST, Tailscale as
 * fallback — the LAN path is faster and does not depend on a third-party mesh
 * being up, so it should never be abandoned lightly.
 *
 * WHY THIS IS STICKY RATHER THAN "TRY BOTH EVERY TIME".
 *
 * SSH_CONNECT_TIMEOUT is 5s and the liveness poll runs every 5s. Trying LAN and
 * then Tailscale on every single poll would cost up to 10s per cycle against a
 * 5s cadence: polls would overlap, get skipped, and the three-consecutive-
 * failure countdown to "offline" would stretch out. Detection would get SLOWER
 * by adding a feature meant to improve reachability.
 *
 * So a failover is remembered. Once the LAN path fails and Tailscale answers,
 * subsequent calls go straight to Tailscale. The LAN is retried on a cooldown so
 * the system comes home by itself when the laptop is back on the home network —
 * it does not stay on the slower path forever just because it once worked.
 *
 * WHAT THIS MODULE DOES NOT DO.
 *
 * It never resolves an address for Wake-on-LAN. WoL is an L2 broadcast to
 * x.y.z.255; Tailscale is L3 with no broadcast domain, so a magic packet sent to
 * a 100.x address is meaningless. Those call sites read `spark.lanIp` literally
 * and must keep doing so.
 */

/** How long to stay on the fallback before re-testing the primary. */
export const PRIMARY_RETRY_COOLDOWN_MS = 60_000;

/**
 * @typedef {object} HostState
 * @property {"primary"|"fallback"} active
 * @property {number} lastPrimaryFailureAt
 * @property {number} failoverCount
 * @property {number} lastSuccessAt
 */

/** @type {Map<string, HostState>} sparkId → state */
const state = new Map();

function stateFor(sparkId) {
  let s = state.get(sparkId);
  if (!s) {
    s = { active: "primary", lastPrimaryFailureAt: 0, failoverCount: 0, lastSuccessAt: 0 };
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
  if (s.active === "primary") return primary;
  // On the fallback: periodically re-offer the primary so a machine that comes
  // back onto the LAN returns to it without needing a restart.
  if (now - s.lastPrimaryFailureAt >= PRIMARY_RETRY_COOLDOWN_MS) return primary;
  return fallback;
}

/** True when `host` is this Spark's fallback address. */
export function isFallbackHost(spark, host) {
  const { fallback } = hostCandidates(spark);
  return !!fallback && clean(host) === fallback;
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
    if (s.active === "primary") s.failoverCount++;
    s.active = "fallback";
    s.lastPrimaryFailureAt = now;
    return fallback;
  }
  // The fallback failed. Go back to preferring the primary next time: if
  // everything is down we want the next cycle to start from the preferred path,
  // not to stay parked on the one that just failed.
  if (clean(host) === fallback) {
    s.active = "primary";
    s.lastPrimaryFailureAt = 0;
  }
  return null;
}

/** Record that an attempt on `host` succeeded. */
export function reportSuccess(spark, host, now = Date.now()) {
  const { primary, fallback } = hostCandidates(spark);
  if (!spark?.id || !fallback || !primary) return;
  const s = stateFor(spark.id);
  s.lastSuccessAt = now;
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
