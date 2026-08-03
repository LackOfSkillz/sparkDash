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
  prefillHistory = [],
}: {
  sparks: SparkSnapshot[];
  /** Recent generation tok/s samples for the trend line. Empty renders a flat placeholder. */
  tpsHistory?: readonly number[];
  /** Recent prefill tok/s samples. Sampled on the same cadence so both traces share an x-axis. */
  prefillHistory?: readonly number[];
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
  // Fall back to the lifetime average only when the backend predates the live field, so an
  // older server shows a stale-but-real number rather than a permanent zero.
  const inLive = llm.prefillTpsLive ?? llm.prefillTps;

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
        {/* The model id used to sit here. It is already named in the cluster summary and again
            in the node card's vLLM field, so a third copy only crowded the row that now has to
            carry two traces. The backend badge still says what kind of engine this is. */}
        <span className="ml-auto flex items-center gap-9">
          {/* Input and output get one trace each, paired with their own number, and the two
              pairs are spaced well apart so it reads as two measurements rather than one
              cluster of digits.

              The two readings are formatted identically — same size, same weight, same one
              decimal place, same reserved width, and each carries its own tok/s rather than
              sharing a single trailing one that sat under only the output. They are the same
              kind of measurement in the same unit, so anything that made one look subordinate
              to the other just read as inconsistency. The trace colour and the IN/OUT label
              carry the distinction.

              Every number is fixed-width and right-aligned. Tabular figures alone were not
              enough: the *count* of digits still changed as a rate crossed from one to two to
              three digits, which resized the group and slid the sparklines sideways on almost
              every poll. Reserving the widest plausible reading (7 characters — "16000.0" on a
              hot prefix cache) means digits grow into their own box and nothing around them
              moves. */}
          <span
            className="flex items-center gap-2.5"
            title="Live input (prefill) rate over a ~20s window: prompt tokens over the seconds those requests spent reaching a first token. Reads 0 when nothing is prefilling. The server-lifetime average is in the Prefill tok/s field below."
          >
            {/* No area fill. The input trace is the secondary reading of the two, and a filled
                shape at this size competes with the output trace next to it. */}
            <Sparkline
              data={prefillHistory}
              width={72}
              height={22}
              color="var(--color-muted)"
              area={false}
            />
            <span className="text-[11px] uppercase tracking-wide text-muted">in</span>
            <span className="font-tabular w-[7ch] text-right text-[22px] font-bold leading-none text-text-strong">
              {inLive.toFixed(1)}
            </span>
            <span className="text-[14px] text-muted">tok/s</span>
          </span>
          <span
            className="flex items-center gap-2.5"
            title="Live generation rate, measured per poll."
          >
            <Sparkline data={tpsHistory} width={72} height={22} />
            <span className="text-[11px] uppercase tracking-wide text-muted">out</span>
            <span className="font-tabular w-[7ch] text-right text-[22px] font-bold leading-none text-text-strong">
              {llm.generationTps.toFixed(1)}
            </span>
            <span className="text-[14px] text-muted">tok/s</span>
          </span>
          {/* A bare ":8888" used to trail the row. It named the port these numbers come from,
              which the cluster summary already states in full as API gx10-9141:8888, and with
              the model id gone it read as a fragment left behind rather than a label. */}
        </span>
      </div>

      {/* Throughput + request state */}
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border pt-3 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="Engine" value="Active" tone="success" />
        {/* Labelled "avg" so it does not read as contradicting the live IN figure above when
            the cluster is idle and that one has fallen back to zero. */}
        <Stat
          label="Prefill avg tok/s"
          value={llm.prefillTps > 0 ? llm.prefillTps.toFixed(1) : "—"}
          title="Server-lifetime average: every prompt token admitted over every second spent reaching a first token."
        />
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
