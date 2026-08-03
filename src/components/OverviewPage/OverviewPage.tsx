import { useEffect, useRef, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
import { shutdownAllSparks, wakeAllSparks } from "../../api/client";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";
import { MetricBar } from "../ui/MetricBar";
import { ActivityIcon, PowerOffIcon, PowerOnIcon } from "../ui/icons";
import { ClusterSummary } from "./ClusterSummary";
import { ClusterLlmPanel } from "./ClusterLlmPanel";
import { SshLaunchRow } from "./SshLaunchRow";
import {
  activeLlm,
  clusterInterface,
  displayRole,
  findHead,
  formatUptime,
  lanInterface,
  clusterRdmaPort,
  fmtRate,
  primaryProcess,
  rdmaHealth,
  rootDisk,
} from "./clusterModel";

interface OverviewPageProps {
  sparks: SparkSnapshot[];
  hideOffline?: boolean;
  temperatureUnit?: "celsius" | "fahrenheit";
  onSelectSpark?: (id: string) => void;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round(c * 9 / 5 + 32);
}

/**
 * Both scales, always. The sensor reports Celsius; Fahrenheit is derived, so showing one and
 * hiding the other only ever costs the reader a conversion. `temperatureUnit` still decides
 * which is written first, so the preference setting keeps meaning something.
 */
function formatTemperature(celsius: number, unit: "celsius" | "fahrenheit"): string {
  const f = celsiusToFahrenheit(celsius);
  const c = Math.round(celsius);
  return unit === "fahrenheit" ? `${f}°F / ${c}°C` : `${c}°C / ${f}°F`;
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Format a storage value in MB, stripping trailing ".0" and optionally omitting the unit. */
function fmtStorage(mb: number, unit: boolean): string {
  const val = mb >= 1024 ? mb / 1024 : mb;
  const label = mb >= 1024 ? "GB" : "MB";
  const s = val.toFixed(1).replace(/\.0$/, "");
  return unit ? `${s} ${label}` : s;
}

function MiniStat({
  label,
  value,
  tone = "default",
  bold = true,
  title,
  wrap = false,
  span = 1,
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "warning" | "danger" | "success";
  bold?: boolean;
  title?: string;
  /** Allow value to wrap (no ellipsis trim) — used for long model ids. */
  wrap?: boolean;
  /** Column span within the parent 4-column grid. Rows that fill only two cells donate
   *  their unused columns rather than truncating a value that has room beside it. */
  span?: 1 | 2 | 3;
}) {
  const toneClass =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : tone === "accent"
          ? "text-accent"
          : tone === "success"
            ? "text-success"
            : "text-text";
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 ${span === 3 ? "col-span-3" : span === 2 ? "col-span-2" : ""}`}>
      <span className="text-[12px] leading-none tracking-wide text-muted">{label}</span>
      <span
        className={`font-tabular text-[15px] leading-tight ${
          wrap
            ? "whitespace-normal break-words leading-snug [overflow-wrap:anywhere]"
            : "truncate"
        } ${bold ? "font-semibold" : ""} ${toneClass}`}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

function SparkCard({
  spark,
  allSparks,
  headSparkName,
  temperatureUnit,
  onSelect,
}: {
  spark: SparkSnapshot;
  allSparks: SparkSnapshot[];
  headSparkName?: string | null;
  temperatureUnit: "celsius" | "fahrenheit";
  onSelect?: (id: string) => void;
}) {
  const gpu = spark.metrics.gpu;
  const um = spark.metrics.unifiedMemory;
  const online = spark.online;

  const usage = gpu?.usage ?? 0;
  const tempRaw = gpu?.temperature ?? 0;
  // The bar still fills against the preferred scale; only the caption shows both.
  const displayTemp = temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(tempRaw) : tempRaw;
  const tempLabel = formatTemperature(tempRaw, temperatureUnit);
  const vramPct = gpu?.vram?.percentage ?? um?.percentage ?? 0;
  const vramUsed = gpu?.vram?.used ?? um?.used ?? 0;
  const vramTotal = gpu?.vram?.total ?? um?.total ?? 0;
  const vramAvail = gpu?.vram?.available ?? um?.available ?? 0;

  // Temperature bar: cool → success, warm → warning, hot → danger
  const tempBarColor =
    tempRaw > 85 ? "bg-danger" : tempRaw > 65 ? "bg-warning" : tempRaw > 40 ? "bg-accent" : "bg-success";
  // Usage bar: accent for moderate, warning high, danger critical
  const usageBarColor = usage > 85 ? "bg-danger" : usage > 60 ? "bg-warning" : "bg-accent";
  // VRAM allocation: accent normal → warning/danger as it fills
  const vramBarColor = vramPct > 85 ? "bg-danger" : vramPct > 60 ? "bg-warning" : "bg-accent";

  return (
    <div
      className="overview-card flex flex-col"
      style={{
        padding: "var(--density-card-pad)",
        gap: "var(--density-card-gap)",
        ...(online ? {} : { opacity: 0.6 }),
      }}
    >
      {/* Card header */}
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-success dot-glow-success" : "bg-danger"}`}
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-strong">
          {onSelect ? (
            <button
              type="button"
              onClick={() => onSelect(spark.id)}
              className="text-left font-inherit text-inherit hover:underline"
            >
              {spark.name}
            </button>
          ) : (
            spark.name
          )}
        </span>
        {(() => {
          const role = resolveSparkRole(spark);
          // Presentation-only: a `standalone` Spark that heads a worker reads as HEAD.
          // Nothing persisted is rewritten — see displayRole().
          const text = displayRole(spark, allSparks);
          const title =
            text === "HEAD"
              ? role === "head"
                ? "Cluster head Spark"
                : "Serving the cluster model — persisted role is 'standalone'"
              : role === "worker"
                ? spark.workerLabel?.trim()
                  ? `${spark.workerLabel.trim()} · distributed LLM worker`
                  : "Distributed LLM worker"
                : spark.llmMonitoring === false
                  ? "Standalone — LLM monitoring off"
                  : "Standalone Spark";
          return (
            <span
              className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent"
              title={title}
            >
              {text}
            </span>
          );
        })()}
        {online && spark.uptime != null && (
          <span className="shrink-0 text-[12px] tracking-wide text-muted" title="Node uptime as reported by the node">
            {formatUptime(spark.uptime)}
          </span>
        )}
        <span className="text-[12px] uppercase tracking-wide text-muted">
          {online ? "online" : "offline"}
        </span>
      </div>

      {!online || !gpu ? (
        <div className="flex h-[120px] items-center justify-center">
          <span className="text-[15px] text-muted">
            {online ? "Waiting for metrics…" : "Host unreachable"}
          </span>
        </div>
      ) : (
        <>
          {/* Three headline bars: GPU alloc, Temp, Usage */}
          <div className="flex flex-col gap-3.5">
            <MetricBar
              label="VRAM"
              value={vramUsed}
              max={vramTotal}
              color={vramBarColor}
              caption={vramTotal > 0 ? `${fmtStorage(vramUsed, false)} / ${fmtStorage(vramTotal, true)}` : "—"}
            />
            <MetricBar
              label="Temperature"
              value={displayTemp}
              max={temperatureUnit === "fahrenheit" ? 212 : 100}
              color={tempBarColor}
              caption={tempLabel}
            />
            <MetricBar
              label="Usage"
              value={usage}
              max={100}
              color={usageBarColor}
              caption={`${usage}%`}
            />
          </div>

          {/* Secondary stats */}
          <div className="mt-3 grid grid-cols-4 gap-x-3 gap-y-2 border-t border-border pt-3">
            <MiniStat
              label="GPU Power"
              value={`${gpu?.power?.draw ?? 0}W / ${gpu?.power?.limit ?? 0}W`}
            />
            {vramAvail > 0 && (
              <MiniStat
                label="Available"
                value={formatMb(vramAvail)}
                tone={vramAvail < 4096 ? "danger" : vramAvail < 16384 ? "warning" : "accent"}
              />
            )}
            {(() => {
              // Find the root disk by label "/" (the collector maps the host
              // root mount to that label). Fall back to the GB10 partition name
              // so the overview keeps working where labels aren't populated.
              const rootDisk =
                spark.metrics.storage.find((d) => d.label === "/") ??
                spark.metrics.storage.find((d) => d.device === "nvme0n1p2");
              if (rootDisk) {
                return (
                  <MiniStat
                    label="Storage"
                    value={`${fmtStorage(rootDisk.used, false)} / ${fmtStorage(rootDisk.total, true)}`}
                    title={`${fmtStorage(rootDisk.used, true)} used of ${fmtStorage(rootDisk.total, true)} (${rootDisk.percentage}%)`}
                    tone={rootDisk.percentage > 85 ? "danger" : rootDisk.percentage > 60 ? "warning" : "default"}
                    bold={false}
                    wrap
                  />
                );
              }
              return null;
            })()}
            {(() => {
              const role = resolveSparkRole(spark);

              // Workers have no local LLM API — show cluster/model label instead.
              if (role === "worker") {
                const label = spark.workerLabel?.trim() || "distributed";
                const title = headSparkName
                  ? `${label} · worker of ${headSparkName}`
                  : `${label} · distributed LLM worker`;
                return (
                  <MiniStat
                    label="Worker"
                    value={label}
                    tone="accent"
                    title={title}
                    wrap
                  />
                );
              }

              // Head / Standalone: same as before — live backend + model id.
              const llmArr = spark.metrics.llm;
              const llm = Array.isArray(llmArr) ? llmArr.find((l) => l.available) : null;
              if (!llm) return null;
              return (
                <MiniStat
                  label={
                    llm.backend === "vllm"
                      ? "vLLM"
                      : llm.backend === "ds4"
                        ? "ds4"
                        : llm.backend === "sglang"
                          ? "sgLang"
                          : llm.backend ?? "LLM"
                  }
                  value={llm.modelId ?? "unknown"}
                  tone="accent"
                  title={llm.modelId ?? undefined}
                  wrap
                />
              );
            })()}
          </div>

          {/* CPU / RAM / connectivity / process all share one 4-column grid: the values the
              overview gained this pass had to fit without making the card taller. */}
          <div className="grid grid-cols-4 gap-x-3 gap-y-2 border-t border-border pt-3">
            <MiniStat
              label="CPU"
              value={
                spark.metrics.cpu
                  ? `${Math.round(spark.metrics.cpu.usage)}%${
                      spark.metrics.cpu.draw ? ` · ${spark.metrics.cpu.draw.toFixed(1)}W` : ""
                    }`
                  : "—"
              }
              tone={(spark.metrics.cpu?.usage ?? 0) > 85 ? "danger" : "default"}
            />
            <MiniStat
              label="RAM"
              value={
                spark.metrics.ram
                  ? `${fmtStorage(spark.metrics.ram.used, false)} / ${fmtStorage(spark.metrics.ram.total, true)}`
                  : "—"
              }
              tone={(spark.metrics.ram?.percentage ?? 0) > 90 ? "warning" : "default"}
              bold={false}
              span={2}
            />
          </div>

          {/* Connectivity — LAN for management, RoCE for the interconnect. The RoCE cell now
              carries address, rate and link state on one line, replacing the previous
              interface-name label rather than adding a row, so card height is unchanged. */}
          {(() => {
            const lan = lanInterface(spark);
            const port = clusterRdmaPort(spark);
            const roceIface = clusterInterface(spark);
            const health = rdmaHealth(port);
            if (!lan && !port && !roceIface) return null;

            const ip = port?.ip ?? roceIface?.ip ?? null;
            const roceValue = port
              ? [ip, port.rateGbps ? `${port.rateGbps} Gb/s` : null, health === "healthy" ? "Active" : (port.state ?? "—")]
                  .filter(Boolean)
                  .join(" · ")
              : (ip ?? "—");

            return (
              <div className="grid grid-cols-4 gap-x-3 gap-y-2 pt-0">
                <MiniStat label="LAN" value={lan?.ip ?? "—"} bold={false} title={lan?.name} />
                <MiniStat
                  label="RoCE"
                  value={roceValue}
                  span={3}
                  tone={health === "healthy" ? "accent" : health === "degraded" ? "warning" : "default"}
                  bold={false}
                  title={
                    port
                      ? `${port.netdev ?? roceIface?.name ?? "?"} · ${port.hca} · ${port.state ?? "?"} / ${port.physicalState ?? "?"} — link state only, not NCCL or rank health`
                      : "No RDMA device reported for this node"
                  }
                />
              </div>
            );
          })()}

          {/* Live RDMA rate, from the HCA counters — netdev bytes stay near zero under RoCE.
              Shares the compute-process row so no extra line is introduced. */}
          {(() => {
            const port = clusterRdmaPort(spark);
            const proc = primaryProcess(spark);
            if (!port && !proc) return null;
            const hasRate = port && (port.txBytesPerSecond !== null || port.rxBytesPerSecond !== null);
            return (
              <div className="grid grid-cols-4 gap-x-3 gap-y-2 pt-0">
                {proc ? (
                  <MiniStat label="Compute process" value={proc} tone="accent" bold={false} span={2} />
                ) : (
                  <span />
                )}
                {port && (
                  <MiniStat
                    label="RDMA"
                    span={2}
                    value={hasRate ? `↑ ${fmtRate(port.txBytesPerSecond)}  ↓ ${fmtRate(port.rxBytesPerSecond)}` : "—"}
                    bold={false}
                    title={
                      hasRate
                        ? "From HCA hardware counters (port_xmit_data / port_rcv_data), not netdev"
                        : "Awaiting a second counter sample — a rate needs a delta"
                    }
                  />
                )}
              </div>
            );
          })()}


        </>
      )}
    </div>
  );
}

export function OverviewPage({ sparks, hideOffline = false, temperatureUnit = "celsius", onSelectSpark }: OverviewPageProps) {
  const visibleSparks = hideOffline ? sparks.filter((s) => s.online) : sparks;
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchMsg, setBatchMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);

  // Rolling 60-second trace of head generation tok/s for the cluster panel's sparkline.
  // Not persisted; it resets on reload. Historical ranges are Phase 2.
  //
  // Sampled on a fixed 1s timer rather than on value change. Appending only when the number
  // moved made the x-axis "distinct values seen" instead of time: a steady 40 tok/s for ten
  // seconds contributed a single point, and once generation stopped the value sat at 0 and
  // nothing was appended at all — so the trace never decayed and kept displaying the shape of
  // a run that had long finished. Measured at 44 points for three requests spread over ~110
  // seconds. A fixed cadence makes the width mean elapsed time and lets idle flatten it out.
  const TPS_TRACE_SECONDS = 60;
  const [tpsHistory, setTpsHistory] = useState<number[]>([]);
  const [prefillHistory, setPrefillHistory] = useState<number[]>([]);
  const headLlm = activeLlm(findHead(sparks));
  const headTps = headLlm?.generationTps ?? null;
  // The live windowed rate, not the lifetime average — the trace has to be able to reach zero.
  const headPrefill = headLlm ? (headLlm.prefillTpsLive ?? headLlm.prefillTps) : null;
  const headTpsRef = useRef<number | null>(null);
  const headPrefillRef = useRef<number | null>(null);
  headTpsRef.current = headTps;
  headPrefillRef.current = headPrefill;
  useEffect(() => {
    const id = setInterval(() => {
      // No reading yet is not the same as zero, so hold the trace until one arrives.
      if (headTpsRef.current !== null) {
        setTpsHistory((prev) => [...prev, headTpsRef.current ?? 0].slice(-TPS_TRACE_SECONDS));
      }
      // Sampled on the same tick as generation so the two traces in the header describe the
      // same 60 seconds and can be read against each other.
      if (headPrefillRef.current !== null) {
        setPrefillHistory((prev) =>
          [...prev, headPrefillRef.current ?? 0].slice(-TPS_TRACE_SECONDS),
        );
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const onlineShutdownCount = sparks.filter((s) => s.online).length;

  async function handleShutdownAll() {
    if (onlineShutdownCount === 0) return;
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await shutdownAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok && !r.skipped).length;
      const skipped = res.results.filter((r) => r.skipped).length;
      const parts = [`${ok} shut down`];
      if (fail) parts.push(`${fail} failed`);
      if (skipped) parts.push(`${skipped} skipped`);
      setBatchMsg({
        text: parts.join(", "),
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch shutdown failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  async function handleWakeAll() {
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await wakeAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok).length;
      setBatchMsg({
        text: fail === 0 ? `${ok} wake packet(s) sent` : `${ok} sent, ${fail} failed`,
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch wake failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  if (visibleSparks.length === 0) {
    const allOffline = hideOffline && sparks.length > 0;
    return (
      <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <ActivityIcon className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-semibold text-text-strong">
          {allOffline ? "All Sparks are offline" : "No Sparks registered"}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {allOffline
            ? "Auto-hide is enabled and no Sparks are currently online."
            : "Click the + tab to add a DGX Spark unit."}
        </p>
      </div>
    );
  }

  const onlineCount = visibleSparks.filter((s) => s.online).length;

  // A "cluster" is a head plus at least one worker. Anything else keeps the original overview.
  const head = findHead(visibleSparks);
  const isCluster = head !== null && visibleSparks.length > 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-overview-rhythm)" }}>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h1
          className="font-normal leading-tight tracking-tight text-text-strong"
          style={{ fontSize: "var(--density-overview-title)" }}
        >
          Overview
        </h1>
        <div className="flex items-center gap-3">
          {batchMsg && (
            <span className={`text-[11px] ${batchMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
              {batchMsg.text}
            </span>
          )}
          {sparks.length > 0 && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleWakeAll()}
                disabled={batchLoading}
                title="Wake all Sparks that have a MAC configured (WoL)"
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted hover:bg-success/20 hover:text-success transition-colors disabled:opacity-50"
              >
                <PowerOnIcon className="h-3 w-3" />
                Wake All
              </button>
              <button
                type="button"
                onClick={() => setShutdownOpen(true)}
                disabled={batchLoading || onlineShutdownCount === 0}
                title="Shut down all online Sparks"
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:bg-danger/20 hover:text-danger disabled:opacity-50"
              >
                <PowerOffIcon className="h-3 w-3" />
                Shutdown All
              </button>
            </div>
          )}
          <span className="online-chip">
            <span className="dot" />
            {onlineCount}/{visibleSparks.length} online
          </span>
        </div>
      </div>
      <ConfirmShutdownDialog
        open={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdownAll}
        title="Shutdown All"
        description={`Gracefully shut down all ${onlineShutdownCount} online Spark${onlineShutdownCount === 1 ? "" : "s"}? Offline nodes will be skipped.`}
        confirmLabel="Shut down all"
      />
      {/* Cluster view only appears once there is a cluster to describe — a single Spark keeps
          the original plain overview rather than gaining a header that says "1 node". */}
      {isCluster && <ClusterSummary sparks={visibleSparks} temperatureUnit={temperatureUnit} />}

      <div
        className={
          isCluster
            ? "overview-page grid sm:grid-cols-2"
            : "overview-page grid sm:grid-cols-2 lg:grid-cols-3"
        }
        style={{ gap: "var(--density-page-gap)" }}
      >
        {visibleSparks.map((spark) => (
          <SparkCard
            key={spark.id}
            spark={spark}
            allSparks={sparks}
            headSparkName={
              spark.workerHeadId
                ? sparks.find((s) => s.id === spark.workerHeadId)?.name ?? null
                : null
            }
            temperatureUnit={temperatureUnit}
            onSelect={onSelectSpark}
          />
        ))}
      </div>

      {isCluster && (
        <ClusterLlmPanel
          sparks={visibleSparks}
          tpsHistory={tpsHistory}
          prefillHistory={prefillHistory}
        />
      )}

      {/* Terminal launchers, aligned one-per-card in the space the panels already left free.
          Outside the cards on purpose: a button inside one would compete with card selection
          and drag reordering. */}
      <SshLaunchRow sparks={visibleSparks} />
    </div>
  );
}