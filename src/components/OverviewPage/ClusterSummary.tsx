import type { SparkSnapshot } from "../../api/types";
import {
  activeLlm,
  aggregate,
  clusterState,
  findHead,
  findWorkers,
  fmtInt,
  fmtMb,
  fmtPair,
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
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className={`font-tabular truncate text-[13px] font-semibold ${toneClass}`} title={title ?? value}>
        {value}
      </span>
    </div>
  );
}

export function ClusterSummary({
  sparks,
  clusterName = "GX10 DeepSeek Cluster",
}: {
  sparks: SparkSnapshot[];
  clusterName?: string;
}) {
  const head = findHead(sparks);
  const workers = findWorkers(sparks);
  const llm = activeLlm(head) ?? activeLlm(sparks.find((s) => activeLlm(s)) ?? null);
  const agg = aggregate(sparks);
  const state = clusterState(sparks);
  const onlineCount = sparks.filter((s) => s.online).length;
  const generating = isGenerating(llm);

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
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
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
            className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
            title="The head endpoint reports work in flight"
          >
            Active
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted">
          {onlineCount}/{sparks.length} nodes online
        </span>
      </div>

      {/* Identity + model facts */}
      <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3.5 sm:grid-cols-3 lg:grid-cols-6">
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
      <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3.5 sm:grid-cols-3 lg:grid-cols-6">
        <Field
          label={partial ? `Cluster VRAM (${agg.reporting}/${agg.expected})` : "Cluster VRAM"}
          value={fmtPair(agg.vramUsed, agg.vramTotal)}
        />
        <Field
          label={partial ? `Cluster RAM (${agg.reporting}/${agg.expected})` : "Cluster RAM"}
          value={fmtPair(agg.ramUsed, agg.ramTotal)}
        />
        <Field label="Cluster storage" value={fmtPair(agg.storageUsed, agg.storageTotal)} />
        <Field
          label="GPU power"
          value={agg.gpuPowerDraw === null ? "—" : `${agg.gpuPowerDraw.toFixed(1)} W`}
        />
        <Field
          label="Avg temp"
          value={agg.avgGpuTemp === null ? "—" : `${Math.round(agg.avgGpuTemp)}°C`}
        />
        <Field
          label="Avg GPU"
          value={agg.avgGpuUsage === null ? "—" : `${Math.round(agg.avgGpuUsage)}%`}
        />
      </div>

      {partial && (
        <p className="mt-2.5 text-[10px] text-muted">
          Aggregates cover {agg.reporting} of {agg.expected} nodes — a node is not reporting, so
          totals are partial rather than cluster-wide.
        </p>
      )}
      {agg.vramTotal !== null && (
        <p className="sr-only">
          Cluster VRAM {fmtMb(agg.vramUsed)} of {fmtMb(agg.vramTotal)}.
        </p>
      )}
    </div>
  );
}
