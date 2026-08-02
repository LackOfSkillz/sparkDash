import type { SparkSnapshot } from "../../api/types";
import { Sparkline } from "../ui/Sparkline";
import {
  activeLlm,
  findHead,
  findWorkers,
  fmtInt,
  fmtPct,
  fmtSeconds,
} from "./clusterModel";

/**
 * Cluster-wide inference panel.
 *
 * The numbers come from the HEAD endpoint only — the worker hosts no API, and presenting its
 * absence as data would be a lie about where the measurement came from. The topology row names
 * both nodes so it is obvious the single endpoint fronts a distributed engine.
 */

function Stat({
  label,
  value,
  tone = "default",
  title,
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "success" | "warning" | "muted";
  title?: string;
}) {
  const toneClass =
    tone === "accent"
      ? "text-accent"
      : tone === "success"
        ? "text-success"
        : tone === "warning"
          ? "text-warning"
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

export function ClusterLlmPanel({
  sparks,
  tpsHistory = [],
}: {
  sparks: SparkSnapshot[];
  /** Recent generation tok/s samples for the trend line. Empty renders a flat placeholder. */
  tpsHistory?: readonly number[];
}) {
  const head = findHead(sparks) ?? sparks.find((s) => activeLlm(s)) ?? null;
  const workers = findWorkers(sparks);
  const llm = activeLlm(head);

  if (!llm) {
    return (
      <div className="panel" style={{ padding: "var(--density-card-pad)" }}>
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 shrink-0 rounded-full bg-muted" />
          <span className="text-[15px] font-semibold text-text-strong">Cluster inference</span>
        </div>
        <p className="mt-3 text-[15px] text-muted">
          No model endpoint is answering. The panel stays blank rather than showing zeros, because
          an idle engine and an unreachable one are different states.
        </p>
      </div>
    );
  }

  const running = llm.requestsRunning ?? 0;
  const waiting = llm.requestsWaiting ?? 0;

  return (
    <div className="panel" style={{ padding: "var(--density-card-pad)" }}>
      {/* Identity row */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <span className="h-2 w-2 shrink-0 rounded-full bg-success dot-glow-success" />
        <span
          className="text-[15px] font-semibold text-text-strong"
          title="Measured at the head endpoint. Latency figures are server-lifetime p95, not per-request."
        >
          Cluster inference
        </span>
        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent">
          {llm.backend === "vllm" ? "vLLM" : (llm.backend ?? "llm")}
        </span>
        <span className="min-w-0 truncate text-[15px] text-text" title={llm.modelId ?? undefined}>
          {llm.modelId ?? "unknown model"}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <Sparkline data={tpsHistory} width={92} height={22} />
          <span className="font-tabular text-[22px] font-bold leading-none text-text-strong">
            {llm.generationTps.toFixed(1)}
          </span>
          <span className="text-[14px] text-muted">tok/s</span>
          {head && <span className="text-[13px] text-muted">:{head.llmPort}</span>}
        </span>
      </div>

      {/* Throughput + request state */}
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border pt-3 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="Engine" value="Active" tone="success" />
        <Stat label="Prefill tok/s" value={llm.prefillTps > 0 ? llm.prefillTps.toFixed(1) : "—"} />
        <Stat label="Total generated" value={fmtInt(llm.totalOutputTokens)} />
        <Stat
          label="Requests"
          value={`${running} run / ${waiting} wait`}
          tone={waiting > 0 ? "warning" : running > 0 ? "accent" : "default"}
        />
        <Stat label="KV cache" value={fmtPct(llm.kvCacheUsage)} />
        <Stat label="Prefix cache" value={fmtPct(llm.prefixCacheHitRate)} />
        <Stat
          label="Preempts"
          value={fmtInt(llm.preemptionsTotal)}
          tone={(llm.preemptionsTotal ?? 0) > 0 ? "warning" : "default"}
        />
        <Stat label="MTP accept" value={fmtPct(llm.mtpAcceptanceRate)} title="Speculative-decoding acceptance rate" />
      </div>

      {/* Latency + capacity + topology */}
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border pt-3 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="TTFT p95" value={fmtSeconds(llm.ttftP95Seconds)} />
        <Stat label="E2E p95" value={fmtSeconds(llm.e2eP95Seconds)} />
        <Stat label="ITL p95" value={fmtSeconds(llm.itlP95Seconds)} />
        <Stat label="Max context" value={llm.contextLength ? fmtInt(llm.contextLength) : "—"} />
        <Stat label="Head" value={head?.name ?? "—"} tone="accent" />
        <Stat
          label={workers.length === 1 ? "Worker" : "Workers"}
          value={workers.length ? workers.map((w) => w.name).join(", ") : "—"}
          tone={workers.length ? "accent" : "muted"}
        />
        <Stat
          label="Topology"
          value={workers.length ? `configured TP=${workers.length + 1}` : "single node"}
          title="Configured from the cluster layout. Per-rank health is not probed yet."
        />
        <Stat
          label="Slots"
          value={llm.slotsTotal > 0 ? `${llm.slotsActive} / ${llm.slotsTotal}` : "—"}
        />
      </div>

    </div>
  );
}
