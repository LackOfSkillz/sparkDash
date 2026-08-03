import fs from "fs";
import path from "path";
import { SystemCollector } from "../collectors/SystemCollector.js";
import { LlmProbe } from "../collectors/LlmProbe.js";
import { sshTest, sshExec } from "../collectors/ssh.js";
import {
  applyLivenessObservation,
  createLivenessState,
  metricFreshness,
  shouldRetainMetrics,
  LIVENESS_FAILURE_THRESHOLD,
  OFFLINE_GRACE_MS,
} from "./nodeLiveness.js";
import {
  POLL_INTERVAL_GPU,
  POLL_INTERVAL_CPU,
  POLL_INTERVAL_NETWORK,
  POLL_INTERVAL_STORAGE,
  POLL_INTERVAL_LLM,
  POLL_INTERVAL_BANDWIDTH,
  POLL_INTERVAL_LIVENESS,
  LLM_PORT,
  HOST_PATHS,
} from "../config.js";

/**
 * How recently the model endpoint must have answered for it to count as evidence that a head
 * node is alive. Without this a stale `available: true` from a probe that stopped running
 * could hold a genuinely dead node online forever.
 */
const LLM_EVIDENCE_MAX_AGE_MS = 15000;

/**
 * SparkMonitor — one per Spark. Owns collectors + rate state + poll loop.
 * Exposes snapshot() for WebSocket pushed payload.
 */
export class SparkMonitor {
  /**
   * @param {object} spark
   * @param {{ onWolMac?: (sparkId: string, mac: string) => void }} [options]
   */
  constructor(spark, options = {}) {
    this.spark = spark;
    this._onWolMac = typeof options.onWolMac === "function" ? options.onWolMac : null;
    this.collector = new SystemCollector(spark);

    // One LlmProbe per port — none when LLM monitoring is off
    this.llmProbes = new Map();
    if (this._llmMonitoringEnabled(spark)) {
      for (const port of this._llmPorts()) {
        this.llmProbes.set(port, new LlmProbe(spark, port));
      }
    }

    // Liveness lives in its own state machine so the policy is testable without a network.
    // `online` and `lastOnlineOk` remain as accessors for compatibility with existing callers.
    this._liveness = createLivenessState();
    /** Last time an LLM probe reported the endpoint available, epoch ms. */
    this._lastLlmOkAt = 0;
    /** Per-domain epoch ms of the last SUCCESSFUL collection, for freshness reporting. */
    this._lastSuccessAt = {};

    // System uptime seconds (from /proc/uptime), null when offline
    this._uptimeSeconds = null;

    // Cached metrics per domain — never null objects for UI safety
    this._metrics = {
      gpu: this.collector._defaultGpu(),
      cpu: this.collector._defaultCpu(),
      ram: this.collector._defaultRam(),
      storage: [],
      network: this.collector._defaultNetwork(),
      unifiedMemory: this.collector._defaultUnifiedMemory(),
      llm: [],
    };
    this._lastUpdate = {};

    // Timers
    this._intervals = [];
    /** @type {ReturnType<typeof setInterval> | null} */
    this._llmIntervalId = null;
    this._running = false;
    /** @type {Record<string, boolean>} in-flight domain guards */
    this._inflight = {};
  }

  /** Hot-update config without tearing down poll loops / rate baselines. */
  updateConfig(spark) {
    const wasLlm = this._llmMonitoringEnabled(this.spark);
    this.spark = spark;
    this.collector.spark = spark;

    // Rebuild LLM probe map — add new ports, remove stale ones, update existing
    const ports = this._llmMonitoringEnabled() ? this._llmPorts() : [];
    const prevProbes = this.llmProbes;
    this.llmProbes = new Map();
    for (const port of ports) {
      const existing = prevProbes.get(port);
      if (existing) {
        existing.spark = spark;
        this.llmProbes.set(port, existing);
      } else {
        this.llmProbes.set(port, new LlmProbe(spark, port));
      }
    }
    if (!this._llmMonitoringEnabled()) {
      this._metrics.llm = [];
    }

    // Toggle LLM poll interval when monitoring enablement flips
    if (this._running && wasLlm !== this._llmMonitoringEnabled()) {
      this._restartLlmPollInterval();
    }
  }

  /**
   * Workers: never. Head: always. Standalone: llmMonitoring (default true).
   * @param {object} [spark]
   */
  _llmMonitoringEnabled(spark = this.spark) {
    const role = spark?.role || (spark?.workerNode ? "worker" : "standalone");
    if (role === "worker") return false;
    if (role === "head") return true;
    return spark?.llmMonitoring !== false;
  }

  /** Start or clear the LLM poll timer based on monitoring flag. */
  _restartLlmPollInterval() {
    if (this._llmIntervalId != null) {
      clearInterval(this._llmIntervalId);
      this._intervals = this._intervals.filter((id) => id !== this._llmIntervalId);
      this._llmIntervalId = null;
    }
    if (this._llmMonitoringEnabled() && this._running) {
      this._llmIntervalId = setInterval(() => this._pollDomain("llm"), POLL_INTERVAL_LLM);
      this._intervals.push(this._llmIntervalId);
      void this._pollDomain("llm");
    }
  }

  /** Returns array of LLM ports from spark config. */
  _llmPorts() {
    const raw = this.spark?.llmPorts;
    if (Array.isArray(raw)) {
      const ports = raw
        .map((v) => (typeof v === "string" ? parseInt(v, 10) : Number(v)))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
      return ports.length > 0 ? ports : [LLM_PORT];
    }
    // Legacy single port
    const n = Number(this.spark?.llmPort);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return [n];
    return [LLM_PORT];
  }

  /** Start background polling. */
  start() {
    if (this._running) return;
    this._running = true;
    this._poll();
    this._intervals.push(setInterval(() => this._pollDomain("gpu"), POLL_INTERVAL_GPU));
    this._intervals.push(setInterval(() => this._pollDomain("cpu"), POLL_INTERVAL_CPU));
    this._intervals.push(setInterval(() => this._pollDomain("network"), POLL_INTERVAL_NETWORK));
    this._intervals.push(setInterval(() => this._pollDomain("storage"), POLL_INTERVAL_STORAGE));
    this._intervals.push(setInterval(() => this._pollDomain("ram"), POLL_INTERVAL_CPU));
    this._intervals.push(setInterval(() => this._pollDomain("memory"), POLL_INTERVAL_BANDWIDTH));
    this._restartLlmPollInterval();
    // Liveness on a slightly slower cadence
    this._intervals.push(setInterval(() => this._checkOnline(), POLL_INTERVAL_LIVENESS));
    console.log(`[SparkMonitor] ${this.spark.id} started`);
  }

  /**
   * Diagnostic counters for this node. Exposed for logging and for the metrics endpoint —
   * deliberately carries no host, user, key path or command text.
   */
  livenessDiagnostics() {
    const c = this._liveness.counters;
    return {
      id: this.spark.id,
      online: this._liveness.online,
      sshReachable: this._liveness.sshReachable,
      llmReachable: this._liveness.llmReachable,
      collectorDegraded: this._liveness.collectorDegraded,
      consecutiveSshFailures: this._liveness.consecutiveSshFailures,
      sshLivenessSuccesses: c.sshLivenessSuccesses,
      sshLivenessFailures: c.sshLivenessFailures,
      llmFallbackSaves: c.llmFallbackSaves,
      pollsSkippedInFlight: c.pollsSkippedInFlight,
      stateTransitions: c.transitions,
      metricFreshness: metricFreshness(this._hardwareLastSuccessAt(), Date.now()),
    };
  }

  /** Stop background polling. */
  stop() {
    this._running = false;
    for (const id of this._intervals) clearInterval(id);
    this._intervals = [];
    this._llmIntervalId = null;
    this._inflight = {};
    console.log(`[SparkMonitor] ${this.spark.id} stopped`);
  }

  /**
   * Oldest successful hardware collection across the SSH-backed domains, which is what the
   * displayed hardware readings actually date from. LLM is excluded: it is polled over HTTP
   * and is unaffected by SSH trouble.
   */
  _hardwareLastSuccessAt() {
    const domains = ["gpu", "cpu", "ram", "network", "storage", "memory"];
    const times = domains.map((d) => this._lastSuccessAt[d]).filter((t) => typeof t === "number" && t > 0);
    return times.length ? Math.min(...times) : 0;
  }

  /**
   * Return a full snapshot of this Spark's metrics.
   *
   * `includeVolatile` adds fields that change on every call (a millisecond age, an epoch of
   * the last collection). They are OFF by default and must stay off for the broadcast path:
   * that path skips sending when a snapshot's JSON is byte-identical to the previous one, and
   * a continuously-changing field defeats the comparison, forcing a broadcast and a full
   * frontend re-render every tick even when nothing measured has moved. Ask for them on
   * request/response endpoints, which are not deduplicated.
   *
   * @param {{ includeVolatile?: boolean }} [options]
   */
  snapshot(options = {}) {
    const ports = this._llmMonitoringEnabled() ? this._llmPorts() : [];
    const now = Date.now();
    const lastSuccess = this._hardwareLastSuccessAt();
    const freshness = metricFreshness(lastSuccess, now);
    const retain = shouldRetainMetrics(this._liveness.online, freshness);
    const blank = {
      gpu: this.collector._defaultGpu(),
      cpu: this.collector._defaultCpu(),
      ram: this.collector._defaultRam(),
      storage: [],
      network: this.collector._defaultNetwork(),
      unifiedMemory: this.collector._defaultUnifiedMemory(),
    };
    return {
      id: this.spark.id,
      name: this.spark.name,
      online: this.online,
      // Reachability split three ways so the UI can tell "host is gone" from "collector is
      // struggling". The overview does not render these yet; they exist so it can.
      sshReachable: this._liveness.sshReachable,
      llmReachable: this._liveness.llmReachable,
      collectorDegraded: this._liveness.collectorDegraded,
      // Banded, so it only changes when the band changes — safe for the deduplicated
      // broadcast. The raw age and timestamp are volatile and opt-in.
      metricFreshness: freshness,
      ...(options.includeVolatile
        ? {
            lastSuccessfulCollectionAt: lastSuccess || null,
            metricAgeMs: lastSuccess ? now - lastSuccess : null,
          }
        : {}),
      uptime: this._uptimeSeconds,
      disabledDevices: this.spark.disabledDevices || [],
      disabledInterfaces: this.spark.disabledInterfaces || [],
      storagePollDisabled: Boolean(this.spark.storagePollDisabled),
      workerNode: Boolean(this.spark.workerNode),
      role: this.spark.role || (this.spark.workerNode ? "worker" : "standalone"),
      workerLabel: this.spark.workerLabel || null,
      workerHeadId: this.spark.workerHeadId || null,
      llmMonitoring: this._llmMonitoringEnabled(),
      llmPort: ports[0] ?? LLM_PORT,
      llmPorts: ports,
      llmApiKeyPorts: Array.isArray(this.spark.llmApiKeyPorts)
        ? this.spark.llmApiKeyPorts
        : Object.keys(this.spark.llmApiKeys || {})
            .map((p) => parseInt(p, 10))
            .filter((n) => Number.isInteger(n)),
      hardware: this._getHardwareSummary(),
      metrics: {
        // NOTE: no `timestamp` here on purpose. The broadcast path skips
        // snapshots whose JSON is byte-identical to the previous one (see
        // startBroadcast); a per-snapshot Date.now() would defeat that cache,
        // forcing a broadcast + frontend re-render every tick even when all
        // measured values are unchanged. The frontend does not consume a
        // metrics timestamp; the WS receive time can serve if one is ever
        // needed.
        // Retained while the node is believed up, however stale: the last real reading with
        // an age attached beats blanking a working cluster because one probe timed out. Once
        // a node is genuinely offline AND its readings have expired, they are dropped rather
        // than left on screen looking current.
        gpu: retain ? this._metrics.gpu : blank.gpu,
        cpu: retain ? this._metrics.cpu : blank.cpu,
        ram: retain ? this._metrics.ram : blank.ram,
        storage: retain ? this._metrics.storage : blank.storage,
        network: retain ? this._metrics.network : blank.network,
        unifiedMemory: retain ? this._metrics.unifiedMemory : blank.unifiedMemory,
        llm: this._metrics.llm,
      },
    };
  }

  // ─── Uptime helper ─────────────────────────────────────────
  /** Read system uptime from /proc/uptime (local or via SSH). */
  async _readUptime() {
    let content;
    if (this.spark.isLocal) {
      const mapped = path.join(HOST_PATHS.PROC, "uptime");
      content = fs.readFileSync(mapped, "utf8");
    } else {
      content = await sshExec(this.spark, "cat /proc/uptime");
    }
    const parts = content.trim().split(/\s+/);
    const secs = parseFloat(parts[0]);
    return Number.isFinite(secs) ? Math.floor(secs) : null;
  }

  // ─── Liveness ─────────────────────────────────────────────
  /** Current online verdict. Backed by the liveness state machine. */
  get online() {
    return this._liveness.online;
  }
  set online(v) {
    this._liveness.online = Boolean(v);
  }
  /** Epoch ms of the last successful SSH liveness probe. */
  get lastOnlineOk() {
    return this._liveness.lastSshOkAt;
  }
  set lastOnlineOk(v) {
    this._liveness.lastSshOkAt = Number(v) || 0;
  }

  /**
   * Is a head node's model endpoint answering right now?
   * Workers are excluded on purpose: a worker hosts no endpoint, so silence there is not
   * evidence of anything. Stale evidence is rejected via LLM_EVIDENCE_MAX_AGE_MS.
   */
  _llmEvidence(now) {
    const eligible = this._llmMonitoringEnabled() && !this.spark.workerNode;
    if (!eligible) return { eligible: false, ok: null };
    const fresh = this._lastLlmOkAt > 0 && now - this._lastLlmOkAt <= LLM_EVIDENCE_MAX_AGE_MS;
    return { eligible: true, ok: fresh };
  }

  async _checkOnline() {
    if (!this._running || this._inflight.online) {
      if (this._inflight.online) this._liveness.counters.pollsSkippedInFlight++;
      return;
    }
    this._inflight.online = true;
    let sshOk = false;
    try {
      if (this.spark.isLocal) {
        await this.collector.pingHost();
        sshOk = true;
      } else {
        const result = await sshTest(this.spark);
        // Re-check after the SSH await — `stop()` may have fired mid-flight
        // (removeSpark / updateSpark). Bail before mutating state.
        if (!this._running) return;
        sshOk = Boolean(result.ok);
      }
    } catch {
      sshOk = false;
    } finally {
      this._inflight.online = false;
    }
    if (!this._running) return;

    const now = Date.now();
    const llm = this._llmEvidence(now);
    const verdict = applyLivenessObservation(this._liveness, {
      sshOk,
      llmOk: llm.ok,
      llmEligible: llm.eligible,
      now,
    });

    if (verdict.changed) {
      // Transitions only — a per-probe log would bury them in normal operation.
      console.log(
        `[SparkMonitor] ${this.spark.id} ${verdict.from ? "online" : "offline"} -> ` +
          `${verdict.to ? "online" : "offline"} (${verdict.reason}; ` +
          `consecutiveSshFailures=${this._liveness.consecutiveSshFailures})`
      );
    }

    if (sshOk) {
      try {
        this._uptimeSeconds = await this._readUptime();
      } catch {
        // Non-fatal — uptime keeps its previous value rather than blanking on one timeout.
      }
    } else if (!this._liveness.online) {
      // Only clear uptime once the node is actually judged offline.
      this._uptimeSeconds = null;
    }
  }

  // ─── Polling ──────────────────────────────────────────────
  async _poll() {
    if (!this._running) return;
    await Promise.all([
      this._checkOnline(),
      this._pollDomain("gpu"),
      this._pollDomain("cpu"),
      this._pollDomain("network"),
      this._pollDomain("storage"),
      this._pollDomain("ram"),
      this._pollDomain("memory"),
      this._pollDomain("llm"),
    ]);
  }

  async _pollDomain(domain) {
    if (!this._running || this._inflight[domain]) return;
    // Skip storage auto-poll when disabled for this spark
    if (domain === "storage" && this.spark.storagePollDisabled) return;
    // Worker nodes: no local LLM API
    if (domain === "llm" && !this._llmMonitoringEnabled()) return;
    this._inflight[domain] = true;
    try {
      let result;
      switch (domain) {
        case "gpu":
          result = await this.collector.collectGpu();
          break;
        case "cpu":
          result = await this.collector.collectCpu();
          break;
        case "ram":
          result = await this.collector.collectRam();
          break;
        case "network":
          result = await this.collector.collectNetwork();
          break;
        case "storage":
          result = await this.collector.collectStorage();
          break;
        case "memory":
          result = await this.collector.collectUnifiedMemory();
          break;
        case "llm":
          // Probe all ports in parallel
          result = await Promise.all(
            Array.from(this.llmProbes.values()).map((probe) => probe.probe())
          );
          break;
      }
      // Re-check after the await — `stop()`/`updateSpark()` may have torn
      // this monitor down mid-flight. Writing `_metrics` on a dead monitor
      // isn't user-visible (monitors.delete already happened) but it's a
      // latent class of bug worth killing, and a replaced monitor could
      // otherwise race the tail-end await onto the wrong object.
      if (!this._running) return;
      switch (domain) {
        case "gpu":
          this._metrics.gpu = result;
          break;
        case "cpu":
          this._metrics.cpu = result;
          break;
        case "ram":
          this._metrics.ram = result;
          break;
        case "network":
          this._metrics.network = result;
          if (result?.wolMac && this._onWolMac) {
            try {
              this._onWolMac(this.spark.id, result.wolMac);
            } catch (err) {
              console.error(`[SparkMonitor] ${this.spark.id} wolMac persist error:`, err.message);
            }
          }
          break;
        case "storage":
          this._metrics.storage = result;
          break;
        case "memory":
          this._metrics.unifiedMemory = result;
          break;
        case "llm": {
          const nowMs = Date.now();
          const anyAvailable = Array.isArray(result) && result.some((l) => l && l.available);
          if (anyAvailable) {
            this._metrics.llm = result;
            this._lastLlmOkAt = nowMs;
          } else if (
            this._lastLlmOkAt > 0 &&
            nowMs - this._lastLlmOkAt <= LLM_EVIDENCE_MAX_AGE_MS &&
            Array.isArray(this._metrics.llm) &&
            this._metrics.llm.some((l) => l && l.available)
          ) {
            // A probe that failed to reach the endpoint is not the endpoint reporting itself
            // gone. Over a marginal link one timed-out probe used to blank the LLM block, and
            // the overview keys its whole cluster layout off that — the panels unmounted and
            // the page reflowed. Hold the last good reading briefly; if the endpoint really is
            // down, the window lapses and the unavailable result lands as normal.
            this._llmRetainedSince = this._llmRetainedSince ?? nowMs;
          } else {
            this._metrics.llm = result;
            this._llmRetainedSince = null;
          }
          if (anyAvailable) this._llmRetainedSince = null;
          break;
        }
      }
      this._lastUpdate[domain] = Date.now();
      this._lastSuccessAt[domain] = Date.now();
    } catch (err) {
      // Deliberately NOT clearing `_metrics[domain]`. A failed poll means we did not learn
      // anything new, not that the hardware reported zero — blanking it here is what made a
      // single timed-out probe look like a dead node. The value keeps its last reading and
      // ages out through the freshness fields instead.
      console.error(`[SparkMonitor] ${this.spark.id} ${domain} poll error:`, err.message);
    } finally {
      this._inflight[domain] = false;
    }
  }

  /** Manually refresh a single domain, bypassing auto-poll guards. */
  async refreshDomain(domain) {
    if (this._inflight[domain]) return;
    this._inflight[domain] = true;
    try {
      let result;
      switch (domain) {
        case "storage":
          result = await this.collector.collectStorage();
          break;
        default:
          // Fall back to _pollDomain for other domains
          this._inflight[domain] = false;
          return this._pollDomain(domain);
      }
      if (!this._running) return;
      this._metrics.storage = result;
      this._lastUpdate[domain] = Date.now();
    } catch (err) {
      console.error(`[SparkMonitor] ${this.spark.id} ${domain} refresh error:`, err.message);
    } finally {
      this._inflight[domain] = false;
    }
  }

  // ─── Hardware summary (cached, computed once) ─────────────
  _getHardwareSummary() {
    return {
      device: "NVIDIA DGX Spark",
      cpuModel: "GB10",
      cpuCores: 20,
      totalMemoryGB: 128,
      gpuChip: "GB10",
      cudaDriver: null,
      storageModel: null,
    };
  }
}
