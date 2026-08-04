import { test, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { llmProbeHost } from "../llmHost.js";
import { LlmProbe } from "../LlmProbe.js";
import {
  resolveHost, reportFailure, reportSuccess, _resetHostState,
} from "../../sparks/hostResolve.js";

/**
 * The two things that silently break when an address can change at runtime.
 *
 * 1. THE SSH BATCH KEY. sshExec coalesces commands per `user@host`. If that key
 *    is computed from raw config while the connection has failed over to
 *    Tailscale, commands aimed at two different addresses land in one batch —
 *    and a batch is concatenated into ONE remote shell invocation, so they all
 *    execute wherever that invocation went.
 *
 * 2. THE PROBE baseUrl LATCH. It used to be a field set in the constructor, so
 *    an existing probe kept talking to the old address forever. A failover
 *    happens at runtime and never touches config, so nothing would have
 *    recreated the probe.
 */

const spark = (over = {}) => ({
  id: "gx10-9141",
  lanIp: "192.168.1.200",
  tailscaleIp: "100.92.130.112",
  ssh: { host: "192.168.1.200", user: "gary", auth: "key" },
  ...over,
});

/** The exact expression sshExec uses to key the batch queue. */
const batchKey = (s) => `${s.ssh?.user || ""}@${resolveHost(s) || ""}`;

beforeEach(() => _resetHostState());

test("the SSH batch key follows the failover", () => {
  const s = spark();
  const before = batchKey(s);
  assert.equal(before, "gary@192.168.1.200");

  reportFailure(s, "192.168.1.200");
  const after = batchKey(s);
  assert.equal(after, "gary@100.92.130.112");
  assert.notEqual(after, before,
    "a key that did not move would merge LAN-addressed and Tailscale-addressed " +
    "commands into a single remote shell invocation");
});

test("the batch key returns to the LAN key when the LAN recovers", () => {
  const s = spark();
  reportFailure(s, "192.168.1.200");
  reportSuccess(s, "192.168.1.200");
  assert.equal(batchKey(s), "gary@192.168.1.200");
});

test("llmProbeHost follows the SSH failover without failing on its own first", () => {
  // DecodeBench and Showcase snapshot this address once and then run for
  // minutes. If the HTTP side had to discover the outage independently, a long
  // job would sit on a dead address for its whole run.
  const s = spark();
  assert.equal(llmProbeHost(s), "192.168.1.200");
  reportFailure(s, "192.168.1.200");
  assert.equal(llmProbeHost(s), "100.92.130.112");
});

test("llmProbeHost keeps its historical contract for existing configs", () => {
  assert.equal(llmProbeHost({ isLocal: true, lanIp: "192.168.1.5" }), "127.0.0.1");
  assert.equal(llmProbeHost({ lanIp: "10.0.0.1" }), "10.0.0.1");
  assert.equal(llmProbeHost({}), "");
  assert.equal(llmProbeHost(null), "");
  // It reads lanIp, NOT ssh.host — a Spark whose ssh.host is a DNS name must
  // not have its LLM target silently moved by this change.
  assert.equal(llmProbeHost({ lanIp: "10.0.0.1", ssh: { host: "elsewhere.local" } }), "10.0.0.1");
});

test("probe baseUrl re-resolves instead of latching at construction", () => {
  const s = spark();
  const probe = new LlmProbe(s, 8888);
  assert.equal(probe.baseUrl, "http://192.168.1.200:8888");
  reportFailure(s, "192.168.1.200");
  assert.equal(probe.baseUrl, "http://100.92.130.112:8888",
    "the same probe object must follow the failover");
  reportSuccess(s, "192.168.1.200");
  assert.equal(probe.baseUrl, "http://192.168.1.200:8888");
});

test("the historical constructor shape still yields the same URL", () => {
  // Dozens of existing probe tests build LlmProbe({ lanIp: "10.0.0.1" }).
  const probe = new LlmProbe({ lanIp: "10.0.0.1" }, 9000);
  assert.equal(probe.baseUrl, "http://10.0.0.1:9000");
});

test("a Spark with no Tailscale address behaves exactly as before", () => {
  const s = spark({ tailscaleIp: null });
  const probe = new LlmProbe(s, 8888);
  assert.equal(batchKey(s), "gary@192.168.1.200");
  assert.equal(probe.baseUrl, "http://192.168.1.200:8888");
  reportFailure(s, "192.168.1.200");
  assert.equal(batchKey(s), "gary@192.168.1.200", "nothing to fail over to");
  assert.equal(probe.baseUrl, "http://192.168.1.200:8888");
});
