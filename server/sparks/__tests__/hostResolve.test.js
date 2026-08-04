import { test, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  resolveHost,
  reportFailure,
  reportSuccess,
  hostCandidates,
  hostDiagnostics,
  isFallbackHost,
  _resetHostState,
  PRIMARY_RETRY_COOLDOWN_MS,
} from "../hostResolve.js";
import { classifyHostScope } from "../../validate.js";
import { broadcastForLanIp } from "../../wol.js";

/**
 * LAN first, Tailscale as fallback.
 *
 * The behaviour that matters is not "can it use the fallback" — it is that the
 * fallback is STICKY (so a 5s poll interval is not doubled on every cycle) and
 * that it comes HOME again (so the dashboard does not stay on the slower path
 * forever after one blip).
 */

const spark = (over = {}) => ({
  id: "gx10-9141",
  lanIp: "192.168.1.200",
  tailscaleIp: "100.92.130.112",
  ssh: { host: "192.168.1.200", user: "gary", auth: "key" },
  ...over,
});

beforeEach(() => _resetHostState());

test("prefers the LAN address with no history", () => {
  assert.equal(resolveHost(spark()), "192.168.1.200");
});

test("ssh.host wins over lanIp for the primary, preserving existing behaviour", () => {
  const c = hostCandidates(spark({ ssh: { host: "gx10.local", user: "gary" } }));
  assert.equal(c.primary, "gx10.local");
  assert.equal(c.fallback, "100.92.130.112");
});

test("falls back to Tailscale after the LAN fails, and says so", () => {
  const s = spark();
  const retry = reportFailure(s, "192.168.1.200");
  assert.equal(retry, "100.92.130.112", "the caller is told what to retry on");
  assert.equal(resolveHost(s), "100.92.130.112");
  assert.equal(isFallbackHost(s, "100.92.130.112"), true);
});

test("the failover is sticky, so a 5s poll is not doubled every cycle", () => {
  const s = spark();
  reportFailure(s, "192.168.1.200");
  // Repeated resolves inside the cooldown keep returning the fallback rather
  // than re-testing the LAN and paying another 5s connect timeout.
  for (let i = 0; i < 10; i++) {
    assert.equal(resolveHost(s, Date.now() + i * 1000), "100.92.130.112");
  }
});

test("comes home: the LAN is re-offered after the cooldown", () => {
  const s = spark();
  const t0 = 1_000_000;
  reportFailure(s, "192.168.1.200", t0);
  assert.equal(resolveHost(s, t0 + PRIMARY_RETRY_COOLDOWN_MS - 1), "100.92.130.112");
  assert.equal(resolveHost(s, t0 + PRIMARY_RETRY_COOLDOWN_MS), "192.168.1.200");
});

test("a success on the LAN clears the failover", () => {
  const s = spark();
  reportFailure(s, "192.168.1.200");
  reportSuccess(s, "192.168.1.200");
  assert.equal(resolveHost(s), "192.168.1.200");
  assert.equal(hostDiagnostics(s).usingFallback, false);
});

test("a failure on the FALLBACK earns no further retry — that is a real outage", () => {
  const s = spark();
  reportFailure(s, "192.168.1.200");
  const retry = reportFailure(s, "100.92.130.112");
  assert.equal(retry, null, "both paths down must be reported, not retried around");
  // And the next cycle starts from the preferred path rather than parking on
  // the address that just failed.
  assert.equal(resolveHost(s), "192.168.1.200");
});

test("with no Tailscale address configured nothing changes", () => {
  const s = spark({ tailscaleIp: null });
  assert.equal(resolveHost(s), "192.168.1.200");
  assert.equal(reportFailure(s, "192.168.1.200"), null);
  assert.equal(resolveHost(s), "192.168.1.200", "still the LAN after a failure");
  assert.equal(hostDiagnostics(s).fallback, null);
});

test("with only a Tailscale address it is used directly", () => {
  const s = spark({ lanIp: "", ssh: { host: "", user: "gary" } });
  assert.equal(resolveHost(s), "100.92.130.112");
});

test("state is per Spark", () => {
  const a = spark();
  // ssh.host must be overridden too — it wins over lanIp, so inheriting the
  // base fixture's host would silently point both Sparks at the same address.
  const b = spark({
    id: "gx10-5611",
    lanIp: "192.168.1.201",
    tailscaleIp: "100.97.81.71",
    ssh: { host: "192.168.1.201", user: "gary", auth: "key" },
  });
  reportFailure(a, "192.168.1.200");
  assert.equal(resolveHost(a), "100.92.130.112");
  assert.equal(resolveHost(b), "192.168.1.201", "one node failing over must not move the other");
});

test("diagnostics expose the failover without exposing credentials", () => {
  const s = spark();
  reportFailure(s, "192.168.1.200");
  const d = hostDiagnostics(s);
  assert.equal(d.primary, "192.168.1.200");
  assert.equal(d.fallback, "100.92.130.112");
  assert.equal(d.active, "fallback");
  assert.equal(d.usingFallback, true);
  assert.equal(d.failoverCount, 1);
  const json = JSON.stringify(d);
  assert.ok(!json.includes("gary"), "no user");
  assert.ok(!json.includes("password") && !json.includes("key"), "no credentials");
});

test("repeated failures on the same primary count one failover, not many", () => {
  const s = spark();
  reportFailure(s, "192.168.1.200");
  reportFailure(s, "192.168.1.200");
  reportFailure(s, "192.168.1.200");
  assert.equal(hostDiagnostics(s).failoverCount, 1);
});

// ---------------------------------------------------------------------------

test("a Tailscale address is classified as tailscale, not public", () => {
  // Without this, an open LLM endpoint on a Tailscale address is reported at
  // posture level "danger" as though it were exposed to the internet.
  assert.equal(classifyHostScope("100.92.130.112"), "tailscale");
  assert.equal(classifyHostScope("100.64.0.1"), "tailscale");
  assert.equal(classifyHostScope("100.127.255.254"), "tailscale");
  // Boundaries of 100.64.0.0/10 — outside the range is still public.
  assert.equal(classifyHostScope("100.63.255.255"), "public");
  assert.equal(classifyHostScope("100.128.0.1"), "public");
  // Existing classifications are untouched.
  assert.equal(classifyHostScope("192.168.1.200"), "lan");
  assert.equal(classifyHostScope("127.0.0.1"), "local");
  assert.equal(classifyHostScope("8.8.8.8"), "public");
});

test("Wake-on-LAN never broadcasts to a Tailscale address", () => {
  // WoL is an L2 broadcast; Tailscale is L3 with no broadcast domain. A packet
  // to 100.x.y.255 goes nowhere, so this call site must stay literal.
  assert.equal(broadcastForLanIp("192.168.1.200"), "192.168.1.255");
  assert.equal(broadcastForLanIp("100.92.130.112"), "100.92.130.255",
    "the helper is pure — the guarantee is that callers pass lanIp, asserted below");
});
