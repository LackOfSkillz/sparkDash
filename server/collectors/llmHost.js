import { resolveHost } from "../sparks/hostResolve.js";

/**
 * Host used for LLM HTTP (probe, Showcase, DecodeBench, connectivity test).
 *
 * Local Sparks probe loopback: engines like ds4-server (Entrpi/ds4-on-spark
 * via ~/models/ds4f/start.sh) default to `--host 127.0.0.1`, so probing the
 * LAN IP would miss them. Remote Sparks still use lanIp (they must bind a
 * reachable interface or sit behind a tunnel).
 *
 * Requires the dashboard process to share the host network namespace when
 * running in Docker (see docker-compose `network_mode: host`).
 *
 * Remote Sparks resolve LAN first and fall back to Tailscale. The decision is
 * shared with SSH via hostResolve, so once SSH discovers the LAN path is gone,
 * the HTTP side follows without having to fail on its own first. That matters
 * for DecodeBench and Showcase, which snapshot this address once and then run
 * for minutes — they would otherwise sit on a dead address for a whole job.
 *
 * @param {{ isLocal?: boolean, lanIp?: string, tailscaleIp?: string } | null | undefined} spark
 * @returns {string}
 */
export function llmProbeHost(spark) {
  if (spark?.isLocal) return "127.0.0.1";
  if (!spark) return "";
  // Preserve the historical contract: this helper reads lanIp, NOT ssh.host.
  // hostResolve prefers ssh.host, so a Spark whose ssh.host is a DNS name would
  // silently change LLM target if this called it directly.
  const lan = spark.lanIp != null ? String(spark.lanIp).trim() : "";
  const tailscale = spark.tailscaleIp != null ? String(spark.tailscaleIp).trim() : "";
  if (!tailscale) return lan;
  if (!lan) return tailscale;
  return resolveHost({ id: spark.id, ssh: { host: lan }, lanIp: lan, tailscaleIp: tailscale });
}
