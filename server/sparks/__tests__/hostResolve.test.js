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
  SETTLED_FAILURE_THRESHOLD,
  shouldRetryTransient,
} from "../hostResolve.js";
import { classifyHostScope } from "../../validate.js";
import { broadcastForLanIp } from "../../wol.js";

/**
 * LAN first, Tailscale as fallback. Settle, stay, re-probe only on loss.
 *
 * The behaviour that matters is not "can it use the fallback" — it is that
 * having settled, it STOPS probing. A machine moves networks about twice a day;
 * a timer-based re-probe meant hundreds of doomed 5-second SSH attempts per day
 * to discover something that announces itself the moment it happens.
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

test("once settled it stays settled — no timer ever re-offers the LAN", () => {
  const s = spark();
  const t0 = 1_000_000;
  reportFailure(s, "192.168.1.200", t0);
  // A full day later, still on the fallback. Nothing re-probes on a schedule.
  for (const minutes of [1, 5, 60, 240, 1440]) {
    assert.equal(resolveHost(s, t0 + minutes * 60_000), "100.92.130.112",
      `still on the fallback after ${minutes} minutes`);
  }
  assert.equal(hostDiagnostics(s).failoverCount, 1,
    "one network change is one failover, not one per probe interval");
});

test("one blip on the settled address does NOT unsettle it", () => {
  // This is what made the first version thrash: a single failed command sent it
  // back to the LAN, which then burned a 5s connect timeout, which settled it
  // again — repeatedly, forever.
  const s = spark();
  reportFailure(s, "192.168.1.200");
  assert.equal(resolveHost(s), "100.92.130.112");

  reportFailure(s, "100.92.130.112");
  assert.equal(resolveHost(s), "100.92.130.112", "one failure is not a lost connection");
  reportFailure(s, "100.92.130.112");
  assert.equal(resolveHost(s), "100.92.130.112", "two is still not");

  // A success in between clears the run.
  reportSuccess(s, "100.92.130.112");
  reportFailure(s, "100.92.130.112");
  reportFailure(s, "100.92.130.112");
  assert.equal(resolveHost(s), "100.92.130.112", "the count is consecutive failures");
});

test("sustained failure on the settled address is the re-probe trigger", () => {
  const s = spark();
  reportFailure(s, "192.168.1.200");
  assert.equal(resolveHost(s), "100.92.130.112");

  // Three consecutive — the connection really is gone.
  for (let i = 0; i < SETTLED_FAILURE_THRESHOLD; i++) reportFailure(s, "100.92.130.112");
  assert.equal(resolveHost(s), "192.168.1.200", "next attempt starts from the LAN again");

  // Back home: the LAN answers and it settles there.
  reportSuccess(s, "192.168.1.200");
  assert.equal(resolveHost(s), "192.168.1.200");
  assert.equal(hostDiagnostics(s).usingFallback, false);
});

test("a full home → office → home cycle costs two failovers, not hundreds", () => {
  const s = spark();
  reportSuccess(s, "192.168.1.200");            // at home
  reportFailure(s, "192.168.1.200");            // left for the office
  reportSuccess(s, "100.92.130.112");           // settled on Tailscale
  for (let i = 0; i < 500; i++) resolveHost(s); // a whole day of polling
  assert.equal(hostDiagnostics(s).failoverCount, 1);

  for (let i = 0; i < SETTLED_FAILURE_THRESHOLD; i++) reportFailure(s, "100.92.130.112"); // lost on the way home
  reportSuccess(s, "192.168.1.200");            // home LAN answers
  assert.equal(resolveHost(s), "192.168.1.200");
  assert.equal(hostDiagnostics(s).failoverCount, 1, "coming home is not a failover");
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
  // It stays on the fallback for now: one failure is not proof the path is gone,
  // and re-offering the LAN here is exactly what caused the thrash.
  assert.equal(resolveHost(s), "100.92.130.112");
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

// ---------------------------------------------------------------------------
// Transient-blip absorption
// ---------------------------------------------------------------------------

test("an isolated failure on a working address is retried on the same address", () => {
  const s = spark();
  reportSuccess(s, "192.168.1.200");
  assert.equal(shouldRetryTransient(s, "192.168.1.200"), true,
    "a path with no failure run behind it gets one immediate retry");
});

test("a host already failing is NOT retried, so an outage is not slowed", () => {
  // Without this guard a dead host pays a doubled connect timeout on every
  // single call — and with a second address to try too, four timeouts a poll.
  const s = spark();
  reportFailure(s, "192.168.1.200");   // settled on the fallback
  reportFailure(s, "100.92.130.112");  // the fallback is now failing too
  assert.equal(shouldRetryTransient(s, "100.92.130.112"), false);
});

test("a success clears the run, so the next blip is absorbed again", () => {
  const s = spark();
  reportFailure(s, "192.168.1.200");
  reportFailure(s, "100.92.130.112");
  assert.equal(shouldRetryTransient(s, "100.92.130.112"), false);
  reportSuccess(s, "100.92.130.112");
  assert.equal(shouldRetryTransient(s, "100.92.130.112"), true);
});

test("only the address currently in use is retried", () => {
  const s = spark();
  reportFailure(s, "192.168.1.200");   // now on the fallback
  assert.equal(shouldRetryTransient(s, "192.168.1.200"), false,
    "the address we already moved off is not worth a second attempt");
  assert.equal(shouldRetryTransient(s, "100.92.130.112"), true);
});

test("an unrelated address is never retried", () => {
  const s = spark();
  assert.equal(shouldRetryTransient(s, "10.9.9.9"), false);
});
