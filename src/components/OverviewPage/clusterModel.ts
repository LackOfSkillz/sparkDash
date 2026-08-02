import type { LlmMetrics, SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";

/**
 * Pure derivations behind the cluster overview.
 *
 * Kept free of React so the arithmetic can be tested directly. Every aggregate here
 * distinguishes "not reported" from "zero": a node that fails to report temperature must not
 * drag the cluster average toward 0, and a missing total must not read as an empty pool.
 * Anything that cannot be computed honestly comes back `null` and the UI shows a dash.
 */

export type ClusterState = "healthy" | "degraded" | "unknown";

export interface ClusterAggregates {
  /** MB. null when no node reported VRAM. */
  vramUsed: number | null;
  vramTotal: number | null;
  ramUsed: number | null;
  ramTotal: number | null;
  storageUsed: number | null;
  storageTotal: number | null;
  /** Watts, summed over reporting nodes. */
  gpuPowerDraw: number | null;
  /** Mean over reporting nodes only. */
  avgGpuTemp: number | null;
  avgGpuUsage: number | null;
  /** How many nodes contributed, so the UI can say the aggregate is partial. */
  reporting: number;
  expected: number;
}

/** Sum that yields null when nothing reported, so "no data" never renders as 0. */
function sumOrNull(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0);
}

/** Mean over reporting nodes only — never divide by the expected node count. */
function meanOrNull(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** The root filesystem, matching the per-node card's own resolution order. */
export function rootDisk(spark: SparkSnapshot) {
  return (
    spark.metrics.storage?.find((d) => d.label === "/") ??
    spark.metrics.storage?.find((d) => d.device === "nvme0n1p2") ??
    null
  );
}

/** First available LLM endpoint on a Spark, or null. Workers never host one. */
export function activeLlm(spark: SparkSnapshot | null | undefined): LlmMetrics | null {
  if (!spark) return null;
  const arr = spark.metrics?.llm;
  if (!Array.isArray(arr)) return null;
  return arr.find((l) => l.available) ?? null;
}

/**
 * Presentation role. A Spark persisted as `standalone` is shown as HEAD only when it actually
 * heads something — i.e. some other Spark is a worker. A lone standalone stays STANDALONE.
 * This changes labels only; nothing persisted is rewritten.
 */
export function displayRole(spark: SparkSnapshot, all: SparkSnapshot[]): "HEAD" | "WORKER" | "STANDALONE" {
  const role = resolveSparkRole(spark);
  if (role === "worker") return "WORKER";
  if (role === "head") return "HEAD";
  const hasWorker = all.some((s) => resolveSparkRole(s) === "worker");
  return hasWorker && activeLlm(spark) ? "HEAD" : "STANDALONE";
}

/** The Spark serving the cluster's model — an explicit head first, else a standalone with an LLM. */
export function findHead(sparks: SparkSnapshot[]): SparkSnapshot | null {
  const explicit = sparks.find((s) => resolveSparkRole(s) === "head");
  if (explicit) return explicit;
  const hasWorker = sparks.some((s) => resolveSparkRole(s) === "worker");
  if (!hasWorker) return null;
  return sparks.find((s) => resolveSparkRole(s) === "standalone" && activeLlm(s)) ?? null;
}

export function findWorkers(sparks: SparkSnapshot[]): SparkSnapshot[] {
  return sparks.filter((s) => resolveSparkRole(s) === "worker");
}

export function aggregate(sparks: SparkSnapshot[]): ClusterAggregates {
  const online = sparks.filter((s) => s.online);
  const gpus = online.map((s) => s.metrics.gpu);
  const disks = online.map((s) => rootDisk(s));

  return {
    vramUsed: sumOrNull(gpus.map((g) => g?.vram?.used)),
    vramTotal: sumOrNull(gpus.map((g) => g?.vram?.total)),
    ramUsed: sumOrNull(online.map((s) => s.metrics.ram?.used)),
    ramTotal: sumOrNull(online.map((s) => s.metrics.ram?.total)),
    storageUsed: sumOrNull(disks.map((d) => d?.used)),
    storageTotal: sumOrNull(disks.map((d) => d?.total)),
    gpuPowerDraw: sumOrNull(gpus.map((g) => g?.power?.draw)),
    avgGpuTemp: meanOrNull(gpus.map((g) => g?.temperature)),
    avgGpuUsage: meanOrNull(gpus.map((g) => g?.usage)),
    reporting: gpus.filter(Boolean).length,
    expected: sparks.length,
  };
}

/**
 * Cluster state.
 *
 * `healthy` requires every configured node online AND a reachable model endpoint. Anything less
 * is `degraded` — a missing worker is a real degradation for a TP=2 deployment, even though the
 * head keeps answering. `unknown` only when there is nothing to judge.
 */
export function clusterState(sparks: SparkSnapshot[]): ClusterState {
  if (sparks.length === 0) return "unknown";
  const allOnline = sparks.every((s) => s.online);
  const llm = activeLlm(findHead(sparks) ?? sparks.find((s) => activeLlm(s)) ?? null);
  if (allOnline && llm) return "healthy";
  return "degraded";
}

/** True while the head endpoint reports work in flight. */
export function isGenerating(llm: LlmMetrics | null): boolean {
  if (!llm) return false;
  return (llm.requestsRunning ?? 0) > 0 || llm.generationTps > 0.05;
}

/** Compact uptime, from the node's own reported seconds — never a browser clock. */
export function formatUptime(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** MB → "12.3 GB" / "512 MB". Dash when absent, so 0 never stands in for unknown. */
export function fmtMb(mb: number | null | undefined, unit = true): string {
  if (typeof mb !== "number" || !Number.isFinite(mb)) return "—";
  if (mb >= 1024) {
    const s = (mb / 1024).toFixed(1).replace(/\.0$/, "");
    return unit ? `${s} GB` : s;
  }
  const s = Math.round(mb).toString();
  return unit ? `${s} MB` : s;
}

/** "195.4 / 243.4 GB", or a dash when either side is unknown. */
export function fmtPair(used: number | null, total: number | null): string {
  if (used === null || total === null) return "—";
  return `${fmtMb(used, false)} / ${fmtMb(total, true)}`;
}

export function fmtPct(fraction: number | null | undefined, digits = 1): string {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function fmtSeconds(s: number | null | undefined): string {
  if (typeof s !== "number" || !Number.isFinite(s)) return "—";
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  return `${s.toFixed(s < 10 ? 2 : 1)} s`;
}

export function fmtInt(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

/** Primary compute process (largest VRAM consumer), e.g. "VLLM::Worker_TP0". */
export function primaryProcess(spark: SparkSnapshot): string | null {
  const procs = spark.metrics.gpu?.processes;
  if (!Array.isArray(procs) || procs.length === 0) return null;
  return procs.slice().sort((a, b) => b.vramMB - a.vramMB)[0]?.name ?? null;
}

/** Interface carrying the cluster (RoCE) address, by convention 192.168.10.x on this cluster. */
export function clusterInterface(spark: SparkSnapshot) {
  const ifaces = spark.metrics.network?.interfaces;
  if (!Array.isArray(ifaces)) return null;
  const up = ifaces.filter((i) => i.operstate === "up" && i.ip);
  return up.find((i) => i.ip?.startsWith("192.168.10.")) ?? null;
}

/** Interface carrying the management/LAN address — the primary route out. */
export function lanInterface(spark: SparkSnapshot) {
  const ifaces = spark.metrics.network?.interfaces;
  if (!Array.isArray(ifaces)) return null;
  const up = ifaces.filter((i) => i.operstate === "up" && i.ip);
  return up.find((i) => !i.ip?.startsWith("192.168.10.")) ?? null;
}
