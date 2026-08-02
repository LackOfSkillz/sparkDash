/**
 * RDMA / RoCE port telemetry.
 *
 * Reads the HCA's own hardware counters under /sys/class/infiniband rather than the netdev
 * counters under /sys/class/net. That distinction is the whole point: RDMA writes go from the
 * card to the wire without traversing the kernel network stack, so netdev byte counters stay
 * near zero while a link is saturated. A large netdev figure alongside a flat port_xmit_data
 * would actually indicate a fallback to TCP.
 *
 * Everything here is pure parsing and arithmetic so it can be tested without a host.
 */

/** InfiniBand data counters are expressed in 4-byte words, per the IB spec. */
export const IB_COUNTER_WORD_BYTES = 4;

/** Shell fragment that dumps every RDMA port's sysfs state in one go. */
export function rdmaProbeCommand() {
  // One pass over sysfs. Emits `key=value` lines per device/port so parsing needs no
  // human-oriented command output. Silent (and empty) on hosts without RDMA.
  return [
    'for d in /sys/class/infiniband/*; do',
    '[ -e "$d" ] || continue;',
    'dev=$(basename "$d");',
    'for p in "$d"/ports/*; do',
    '[ -e "$p" ] || continue;',
    'port=$(basename "$p");',
    'echo "dev=$dev";',
    'echo "port=$port";',
    'echo "state=$(cat "$p"/state 2>/dev/null)";',
    'echo "phys=$(cat "$p"/phys_state 2>/dev/null)";',
    'echo "link_layer=$(cat "$p"/link_layer 2>/dev/null)";',
    'echo "rate=$(cat "$p"/rate 2>/dev/null)";',
    'echo "netdev=$(cat "$p"/gid_attrs/ndevs/0 2>/dev/null)";',
    'echo "xmit_data=$(cat "$p"/counters/port_xmit_data 2>/dev/null)";',
    'echo "rcv_data=$(cat "$p"/counters/port_rcv_data 2>/dev/null)";',
    'echo "xmit_pkts=$(cat "$p"/counters/port_xmit_packets 2>/dev/null)";',
    'echo "rcv_pkts=$(cat "$p"/counters/port_rcv_packets 2>/dev/null)";',
    'echo "end=1";',
    'done; done',
  ].join(" ");
}

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * "4: ACTIVE" -> "ACTIVE"; "5: LinkUp" -> "LinkUp". sysfs prefixes an enum ordinal.
 */
function enumValue(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const idx = s.indexOf(":");
  return (idx >= 0 ? s.slice(idx + 1) : s).trim() || null;
}

/** "200 Gb/sec (4X HDR)" -> 200 */
export function parseRateGbps(raw) {
  if (!raw) return null;
  const m = String(raw).match(/([\d.]+)\s*Gb/i);
  return m ? Number(m[1]) : null;
}

/** Parse the block output of {@link rdmaProbeCommand} into raw port records. */
export function parseRdmaPorts(output) {
  if (!output || typeof output !== "string") return [];
  const ports = [];
  let cur = null;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "dev") {
      cur = { hca: value, port: 1 };
      continue;
    }
    if (!cur) continue;
    switch (key) {
      case "port":
        cur.port = num(value) ?? 1;
        break;
      case "state":
        cur.state = enumValue(value);
        break;
      case "phys":
        cur.physicalState = enumValue(value);
        break;
      case "link_layer":
        cur.linkLayer = value || null;
        break;
      case "rate":
        cur.rateGbps = parseRateGbps(value);
        break;
      case "netdev":
        cur.netdev = value || null;
        break;
      case "xmit_data":
        cur.xmitWords = num(value);
        break;
      case "rcv_data":
        cur.rcvWords = num(value);
        break;
      case "xmit_pkts":
        cur.txPackets = num(value);
        break;
      case "rcv_pkts":
        cur.rxPackets = num(value);
        break;
      case "end":
        ports.push(cur);
        cur = null;
        break;
      default:
        break;
    }
  }
  return ports;
}

/**
 * Turn a raw port record plus the previous sample into API-shaped metrics.
 *
 * Rates are null — not zero — on the first sample and after a counter reset, because a node
 * restart would otherwise render as an enormous spike, and "we don't know yet" is not "idle".
 *
 * @param {object} port raw record from {@link parseRdmaPorts}
 * @param {{ txBytes: number|null, rxBytes: number|null, time: number }|undefined} prev
 * @param {number} now epoch ms
 * @param {string|null} ip IPv4 bound to the port's netdev, if known
 */
export function toRdmaPortMetrics(port, prev, now, ip = null) {
  const txBytes = port.xmitWords === null || port.xmitWords === undefined ? null : port.xmitWords * IB_COUNTER_WORD_BYTES;
  const rxBytes = port.rcvWords === null || port.rcvWords === undefined ? null : port.rcvWords * IB_COUNTER_WORD_BYTES;

  let txBytesPerSecond = null;
  let rxBytesPerSecond = null;
  if (prev && typeof prev.time === "number") {
    const dtSec = (now - prev.time) / 1000;
    if (dtSec > 0) {
      // A decrease means the counter reset (reboot, driver reload). Report unknown rather
      // than a negative rate or a fabricated zero.
      if (txBytes !== null && typeof prev.txBytes === "number" && txBytes >= prev.txBytes) {
        txBytesPerSecond = Math.round((txBytes - prev.txBytes) / dtSec);
      }
      if (rxBytes !== null && typeof prev.rxBytes === "number" && rxBytes >= prev.rxBytes) {
        rxBytesPerSecond = Math.round((rxBytes - prev.rxBytes) / dtSec);
      }
    }
  }

  return {
    hca: port.hca,
    port: port.port ?? 1,
    netdev: port.netdev ?? null,
    ip: ip ?? null,
    state: port.state ?? null,
    physicalState: port.physicalState ?? null,
    linkLayer: port.linkLayer ?? null,
    rateGbps: port.rateGbps ?? null,
    txBytes,
    rxBytes,
    txBytesPerSecond,
    rxBytesPerSecond,
    txPackets: port.txPackets ?? null,
    rxPackets: port.rxPackets ?? null,
  };
}

/**
 * Conservative per-port health.
 *
 * Traffic is deliberately not an input: an idle link legitimately sits at 0 B/s, and calling
 * that unhealthy would train the reader to ignore the field. This describes the LINK only —
 * it says nothing about whether NCCL or the tensor-parallel ranks are actually well.
 */
export function rdmaPortHealth(m) {
  if (!m) return "unavailable";
  const active = String(m.state ?? "").toUpperCase() === "ACTIVE";
  const linkUp = String(m.physicalState ?? "").toUpperCase().replace(/[^A-Z]/g, "") === "LINKUP";
  if (active && linkUp && m.rateGbps && m.ip) return "healthy";
  if (m.state || m.physicalState || m.rateGbps) return "degraded";
  return "unavailable";
}

/** Pick the port that carries the cluster interconnect, preferring a named netdev. */
export function selectClusterPort(ports, preferredNetdev = null) {
  if (!Array.isArray(ports) || ports.length === 0) return null;
  const withIp = ports.filter((p) => p.ip);
  if (preferredNetdev) {
    const exact = ports.find((p) => p.netdev === preferredNetdev);
    if (exact) return exact;
  }
  // An addressed, ACTIVE port beats an unaddressed one — this is what excludes the
  // similarly named decoy interface that carries no IPv4.
  const activeAddressed = withIp.find((p) => String(p.state ?? "").toUpperCase() === "ACTIVE");
  if (activeAddressed) return activeAddressed;
  return withIp[0] ?? ports.find((p) => String(p.state ?? "").toUpperCase() === "ACTIVE") ?? ports[0];
}

/**
 * Cluster-level interconnect health across nodes.
 *
 * Degraded when the two ends disagree, because a point-to-point link with one healthy end is
 * not a working interconnect.
 */
export function clusterInterconnectHealth(healths) {
  const list = (healths ?? []).filter(Boolean);
  if (list.length === 0) return "unavailable";
  if (list.every((h) => h === "unavailable")) return "unavailable";
  if (list.every((h) => h === "healthy")) return "healthy";
  return "degraded";
}
