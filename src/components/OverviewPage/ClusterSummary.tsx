import type { SparkSnapshot } from "../../api/types";
import {
  activeLlm,
  aggregate,
  clusterLinkTraffic,
  clusterRdmaHealth,
  clusterRdmaPort,
  clusterState,
  findHead,
  findWorkers,
  fmtInt,
  fmtPair,
  fmtRate,
  isGenerating,
} from "./clusterModel";

/**
 * Cluster summary + aggregate strip.
 *
 * One glance should answer: is the cluster healthy, are both nodes up, is the model live, and
 * how loaded is the pair. Everything is derived from the same snapshots the node cards use — no
 * extra backend call, and nothing invented when a value is missing.
 */

function Field({
  label,
  value,
  tone = "default",
  title,
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "success" | "warning" | "danger" | "muted";
  title?: string;
}) {
  const toneClass =
    tone === "accent"
      ? "text-accent"
      : tone === "success"
        ? "text-success"
        : tone === "warning"
          ? "text-warning"
          : tone === "danger"
            ? "text-danger"
            : tone === "muted"
              ? "text-muted"
              : "text-text-strong";
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[12px] uppercase leading-none tracking-wide text-muted">{label}</span>
      <span className={`font-tabular truncate text-[15px] font-semibold leading-tight ${toneClass}`} title={title ?? value}>
        {value}
      </span>
    </div>
  );
}

export function ClusterSummary({
  sparks,
  // Named for the hardware, not the model — the cluster outlives whatever is loaded on it.
  clusterName = "AIpocalypse Cluster",
  temperatureUnit = "celsius",
}: {
  sparks: SparkSnapshot[];
  clusterName?: string;
  /** Decides which unit leads. Both are always shown; this only sets the order, so the
      average here reads the same way round as the per-node temperatures below it. */
  temperatureUnit?: "celsius" | "fahrenheit";
}) {
  const head = findHead(sparks);
  const workers = findWorkers(sparks);
  const llm = activeLlm(head) ?? activeLlm(sparks.find((s) => activeLlm(s)) ?? null);
  const agg = aggregate(sparks);
  const state = clusterState(sparks);
  const onlineCount = sparks.filter((s) => s.online).length;
  const generating = isGenerating(llm);
  const rdma = clusterRdmaHealth(sparks);
  const headPort = head ? clusterRdmaPort(head) : null;
  const link = clusterLinkTraffic(sparks);

  // TP size is a configured fact, not something we can currently probe. Label it that way.
  const tpSize = head && workers.length > 0 ? workers.length + 1 : null;

  const stateLabel = state === "healthy" ? "Healthy" : state === "degraded" ? "Degraded" : "Unknown";
  const stateTone = state === "healthy" ? "success" : state === "degraded" ? "warning" : "muted";

  // Only claim an aggregate is cluster-wide when every node contributed.
  const partial = agg.reporting > 0 && agg.reporting < agg.expected;

  return (
    <div className="panel" style={{ padding: "var(--density-card-pad)" }}>
      {/* Identity row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            state === "healthy" ? "bg-success dot-glow-success" : state === "degraded" ? "bg-warning" : "bg-muted"
          }`}
        />
        <span className="text-[15px] font-semibold text-text-strong">{clusterName}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
            state === "healthy" ? "bg-success/15 text-success" : state === "degraded" ? "bg-warning/15 text-warning" : "bg-accent/10 text-muted"
          }`}
          title={
            state === "healthy"
              ? "All configured nodes online and the model API is answering"
              : "A node is offline or the model API is unreachable"
          }
        >
          {stateLabel}
        </span>
        {generating && (
          <span
            className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent"
            title="The head endpoint reports work in flight"
          >
            Active
          </span>
        )}
        {/* Partial coverage rides in the identity row, which already has this height. It used
            to be a paragraph below the aggregates, and that extra line was what pushed the
            overview past one viewport at exactly the moment a node stopped reporting. */}
        {partial && (
          <span
            className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-warning"
            title={`Aggregates cover ${agg.reporting} of ${agg.expected} nodes — a node is not reporting, so totals are partial rather than cluster-wide.`}
          >
            Partial
          </span>
        )}
        <span className="ml-auto text-[13px] text-muted">
          {onlineCount}/{sparks.length} nodes online
        </span>
      </div>

      {/* Identity + model facts */}
      <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-2 border-t border-border pt-3 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="Model" value={llm?.modelId ?? "—"} tone="accent" title={llm?.modelId ?? undefined} />
        <Field
          label="Backend"
          value={llm?.backend === "vllm" ? "vLLM" : (llm?.backend ?? "—")}
          tone={llm ? "default" : "muted"}
        />
        <Field
          label="Topology"
          // Kept short so it never ellipsises at 1280; the full wording, and the fact that TP is
          // configured rather than probed, lives in the tooltip and in the cluster inference panel.
          value={tpSize ? `${sparks.length} nodes · TP=${tpSize}` : `${sparks.length} node${sparks.length === 1 ? "" : "s"}`}
          title={
            tpSize
              ? `Configured TP=${tpSize}, read from the cluster layout. Per-rank health is not probed.`
              : undefined
          }
        />
        <Field label="Max context" value={llm?.contextLength ? fmtInt(llm.contextLength) : "—"} />
        <Field
          label="Requests"
          value={llm ? `${llm.requestsRunning ?? 0} run / ${llm.requestsWaiting ?? 0} wait` : "—"}
          tone={(llm?.requestsWaiting ?? 0) > 0 ? "warning" : "default"}
        />
        <Field
          label="API"
          value={head ? `${head.name}:${head.llmPort}` : "—"}
          tone={llm ? "success" : "muted"}
          title={head ? `Model served from ${head.name} on port ${head.llmPort}` : undefined}
        />
      </div>

      {/* Aggregate strip */}
      <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-2 border-t border-border pt-3 sm:grid-cols-3 lg:grid-cols-6">
        <Field
          label={partial ? `Cluster VRAM (${agg.reporting}/${agg.expected})` : "Cluster VRAM"}
          value={fmtPair(agg.vramUsed, agg.vramTotal)}
        />
        <Field
          label={partial ? `Cluster RAM (${agg.reporting}/${agg.expected})` : "Cluster RAM"}
          value={fmtPair(agg.ramUsed, agg.ramTotal)}
        />
        {/* Cluster storage was removed from this strip to make room for the interconnect
            without adding a third row. Both node cards still show their own storage, and a
            filling root disk is far less urgent than a dead RoCE link on a TP=2 cluster. */}
        <Field
          label="GPU power"
          value={agg.gpuPowerDraw === null ? "—" : `${agg.gpuPowerDraw.toFixed(1)} W`}
        />
        <Field
          label="Avg temp"
          value={
            agg.avgGpuTemp === null
              ? "—"
              : temperatureUnit === "fahrenheit"
                ? `${Math.round(agg.avgGpuTemp * 9 / 5 + 32)}°F / ${Math.round(agg.avgGpuTemp)}°C`
                : `${Math.round(agg.avgGpuTemp)}°C / ${Math.round(agg.avgGpuTemp * 9 / 5 + 32)}°F`
          }
        />
        <Field
          label="Avg GPU"
          value={agg.avgGpuUsage === null ? "—" : `${Math.round(agg.avgGpuUsage)}%`}
        />
        <Field
          label="Interconnect"
          value={
            rdma === "healthy"
              ? `RoCE${headPort?.rateGbps ? ` · ${headPort.rateGbps} Gb/s` : ""}`
              : rdma === "degraded"
                ? "RoCE degraded"
                : "—"
          }
          tone={rdma === "healthy" ? "success" : rdma === "degraded" ? "warning" : "muted"}
          title={
            headPort
              ? `${headPort.hca} · ${headPort.netdev ?? "?"} · ${headPort.state ?? "?"} / ${headPort.physicalState ?? "?"} — link state only; NCCL and rank health are not probed`
              : "No RDMA device reported"
          }
        />
        <Field
          label={link.source ? `RDMA · ${link.source}` : "RDMA traffic"}
          value={
            link.txBytesPerSecond === null && link.rxBytesPerSecond === null
              ? "—"
              : `↑ ${fmtRate(link.txBytesPerSecond)}  ↓ ${fmtRate(link.rxBytesPerSecond)}`
          }
          tone={(link.txBytesPerSecond ?? 0) > 1024 * 1024 ? "accent" : "default"}
          title="Head-side hardware counters. Not summed with the worker, which mirrors the same bytes."
        />
      </div>

    </div>
  );
}
