import { useCallback, useRef, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { launchSshShell } from "../../api/client";
import { TerminalIcon } from "../ui/icons";
import { displayRole, lanInterface } from "./clusterModel";

/**
 * One SSH launch button per node, sitting in the space below the cluster inference panel.
 *
 * The button sends nothing but the Spark id — host, user and every ssh argument are resolved
 * on the server (see server/sshShell.js). Deliberately a sibling of the node cards rather than
 * a control inside them, so a click here can never be confused with card selection or drag
 * reordering.
 */

function LaunchButton({
  spark,
  allSparks,
}: {
  spark: SparkSnapshot;
  allSparks: SparkSnapshot[];
}) {
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not the state flag: two clicks in the same tick would both read the stale state.
  const inFlight = useRef(false);

  const onClick = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLaunching(true);
    setError(null);
    try {
      await launchSshShell(spark.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Launch failed");
    } finally {
      inFlight.current = false;
      setLaunching(false);
    }
  }, [spark.id]);

  const role = displayRole(spark, allSparks);
  // The management address, which is the one SSH actually uses — not the RoCE address.
  const ip = lanInterface(spark)?.ip ?? null;

  const detail = [role ? role.charAt(0) + role.slice(1).toLowerCase() : null, ip]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={launching}
      aria-busy={launching}
      title={error ? `${spark.name}: ${error}` : `Open a Windows Terminal SSH session to ${spark.name}`}
      className={`flex h-[38px] w-full items-center justify-center gap-2 rounded-md border bg-surface-elevated px-3 text-[13px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 ${
        error
          ? "border-danger/50 text-danger hover:bg-danger/10"
          : "border-border text-muted hover:bg-accent/15 hover:text-accent"
      }`}
    >
      <TerminalIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        {launching ? "Launching SSH…" : `Launch SSH Shell · ${spark.name}`}
      </span>
      {/* The failure replaces the secondary detail rather than sitting under the button: an
          extra line would grow the page and cost the overview its single-viewport fit at the
          exact moment something has gone wrong. Full text stays in the tooltip. */}
      {!launching && (error || detail) && (
        <span
          className={`shrink-0 truncate text-[11px] ${error ? "text-danger" : "text-muted/70"}`}
          role={error ? "alert" : undefined}
        >
          {error ?? detail}
        </span>
      )}
    </button>
  );
}

export function SshLaunchRow({ sparks }: { sparks: SparkSnapshot[] }) {
  if (sparks.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-[var(--density-page-gap)] sm:grid-cols-2">
      {sparks.map((spark) => (
        <LaunchButton key={spark.id} spark={spark} allSparks={sparks} />
      ))}
    </div>
  );
}
