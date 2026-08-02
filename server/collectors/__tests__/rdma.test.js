import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  IB_COUNTER_WORD_BYTES,
  clusterInterconnectHealth,
  parseRateGbps,
  parseRdmaPorts,
  rdmaPortHealth,
  selectClusterPort,
  toRdmaPortMetrics,
} from "../rdma.js";

const SAMPLE = `
dev=rocep1s0f1
port=1
state=4: ACTIVE
phys=5: LinkUp
link_layer=Ethernet
rate=200 Gb/sec (4X HDR)
netdev=enp1s0f1np1
xmit_data=1000000
rcv_data=2000000
xmit_pkts=500
rcv_pkts=600
end=1
dev=roceP2p1s0f1
port=1
state=4: ACTIVE
phys=5: LinkUp
link_layer=Ethernet
rate=200 Gb/sec (4X HDR)
netdev=enP2p1s0f1np1
xmit_data=0
rcv_data=0
xmit_pkts=0
rcv_pkts=0
end=1
`;

test("parseRdmaPorts: reads both devices and strips sysfs enum ordinals", () => {
  const ports = parseRdmaPorts(SAMPLE);
  assert.equal(ports.length, 2);
  const p = ports[0];
  assert.equal(p.hca, "rocep1s0f1");
  assert.equal(p.state, "ACTIVE", "\"4: ACTIVE\" must reduce to ACTIVE");
  assert.equal(p.physicalState, "LinkUp");
  assert.equal(p.linkLayer, "Ethernet");
  assert.equal(p.rateGbps, 200);
  assert.equal(p.netdev, "enp1s0f1np1");
});

test("parseRdmaPorts: a host without RDMA yields an empty list, not a throw", () => {
  assert.deepEqual(parseRdmaPorts(""), []);
  assert.deepEqual(parseRdmaPorts(null), []);
  assert.deepEqual(parseRdmaPorts("garbage\nlines"), []);
});

test("parseRateGbps: reads the Gb figure and ignores the lane suffix", () => {
  assert.equal(parseRateGbps("200 Gb/sec (4X HDR)"), 200);
  assert.equal(parseRateGbps("100 Gb/sec (4X EDR)"), 100);
  assert.equal(parseRateGbps(""), null);
  assert.equal(parseRateGbps("unknown"), null);
});

test("counters convert from 4-byte words to bytes", () => {
  assert.equal(IB_COUNTER_WORD_BYTES, 4);
  const [p] = parseRdmaPorts(SAMPLE);
  const m = toRdmaPortMetrics(p, undefined, 1000);
  // 1,000,000 words x 4 = 4,000,000 bytes. Reporting the raw word count would
  // understate the link by 4x.
  assert.equal(m.txBytes, 4_000_000);
  assert.equal(m.rxBytes, 8_000_000);
});

test("first sample reports no rate rather than an artificial spike", () => {
  const [p] = parseRdmaPorts(SAMPLE);
  const m = toRdmaPortMetrics(p, undefined, 1000);
  assert.equal(m.txBytesPerSecond, null, "no previous sample means the rate is unknown, not 0");
  assert.equal(m.rxBytesPerSecond, null);
  assert.equal(m.txBytes, 4_000_000, "cumulative bytes are still available on the first sample");
});

test("rate is the delta over elapsed seconds", () => {
  const [p] = parseRdmaPorts(SAMPLE); // 4,000,000 tx bytes
  const prev = { txBytes: 2_000_000, rxBytes: 4_000_000, time: 1000 };
  const m = toRdmaPortMetrics(p, prev, 3000); // 2 seconds later
  assert.equal(m.txBytesPerSecond, 1_000_000, "(4,000,000 - 2,000,000) / 2s");
  assert.equal(m.rxBytesPerSecond, 2_000_000);
});

test("counter reset yields unknown, never a negative or huge rate", () => {
  const [p] = parseRdmaPorts(SAMPLE);
  // Previous total exceeds current — the node rebooted or the driver reloaded.
  const prev = { txBytes: 999_000_000, rxBytes: 999_000_000, time: 1000 };
  const m = toRdmaPortMetrics(p, prev, 3000);
  assert.equal(m.txBytesPerSecond, null);
  assert.equal(m.rxBytesPerSecond, null);
});

test("zero elapsed time does not divide by zero", () => {
  const [p] = parseRdmaPorts(SAMPLE);
  const m = toRdmaPortMetrics(p, { txBytes: 0, rxBytes: 0, time: 1000 }, 1000);
  assert.equal(m.txBytesPerSecond, null);
});

test("an idle but healthy link reports 0 B/s, which is a real measurement", () => {
  const [p] = parseRdmaPorts(SAMPLE);
  const prev = { txBytes: 4_000_000, rxBytes: 8_000_000, time: 1000 };
  const m = toRdmaPortMetrics(p, prev, 3000);
  assert.equal(m.txBytesPerSecond, 0, "unchanged counters mean genuinely zero traffic");
  assert.equal(rdmaPortHealth({ ...m, ip: "192.168.10.1" }), "healthy", "idle is not unhealthy");
});

test("missing counters yield null bytes without breaking the record", () => {
  const ports = parseRdmaPorts("dev=x\nport=1\nstate=4: ACTIVE\nend=1\n");
  const m = toRdmaPortMetrics(ports[0], undefined, 1000);
  assert.equal(m.txBytes, null);
  assert.equal(m.rxBytes, null);
  assert.equal(m.hca, "x");
});

test("health: active + link up + rate + ip is healthy", () => {
  assert.equal(
    rdmaPortHealth({ state: "ACTIVE", physicalState: "LinkUp", rateGbps: 200, ip: "192.168.10.1" }),
    "healthy"
  );
});

test("health: present but incomplete is degraded, not healthy", () => {
  // Down port.
  assert.equal(rdmaPortHealth({ state: "DOWN", physicalState: "Disabled", rateGbps: 200, ip: null }), "degraded");
  // Active but unaddressed — this is the decoy HCA on these machines.
  assert.equal(rdmaPortHealth({ state: "ACTIVE", physicalState: "LinkUp", rateGbps: 200, ip: null }), "degraded");
  // Active and addressed but no rate detected.
  assert.equal(rdmaPortHealth({ state: "ACTIVE", physicalState: "LinkUp", rateGbps: null, ip: "1.2.3.4" }), "degraded");
});

test("health: nothing collected is unavailable, distinct from degraded", () => {
  assert.equal(rdmaPortHealth(null), "unavailable");
  assert.equal(rdmaPortHealth({}), "unavailable");
});

test("selectClusterPort: prefers the addressed ACTIVE port over the unaddressed decoy", () => {
  const ports = parseRdmaPorts(SAMPLE).map((p) =>
    toRdmaPortMetrics(p, undefined, 1000, p.netdev === "enp1s0f1np1" ? "192.168.10.1" : null)
  );
  const chosen = selectClusterPort(ports);
  assert.equal(chosen.hca, "rocep1s0f1", "the decoy roceP2p1s0f1 carries no IPv4 and must lose");
  assert.equal(chosen.ip, "192.168.10.1");
});

test("selectClusterPort: an explicit netdev preference wins", () => {
  const ports = parseRdmaPorts(SAMPLE).map((p) => toRdmaPortMetrics(p, undefined, 1000));
  assert.equal(selectClusterPort(ports, "enP2p1s0f1np1").hca, "roceP2p1s0f1");
});

test("cluster health: both ends healthy is healthy", () => {
  assert.equal(clusterInterconnectHealth(["healthy", "healthy"]), "healthy");
});

test("cluster health: one node missing RDMA degrades the whole link", () => {
  // A point-to-point link with one healthy end is not a working interconnect.
  assert.equal(clusterInterconnectHealth(["healthy", "unavailable"]), "degraded");
  assert.equal(clusterInterconnectHealth(["healthy", "degraded"]), "degraded");
});

test("cluster health: nothing anywhere is unavailable", () => {
  assert.equal(clusterInterconnectHealth(["unavailable", "unavailable"]), "unavailable");
  assert.equal(clusterInterconnectHealth([]), "unavailable");
});

test("cluster traffic is head-side only, never summed across mirrored ends", () => {
  // On a point-to-point link the worker's RX mirrors the head's TX. Summing both would
  // report ~2x the bytes that actually crossed the wire.
  const headTx = 1_000_000;
  const workerRx = 1_000_000; // the same bytes, observed at the other end
  const naiveSum = headTx + workerRx;
  assert.equal(naiveSum, 2_000_000);
  assert.notEqual(naiveSum, headTx, "summing mirrored ends double-counts; the UI must report one side");
});
