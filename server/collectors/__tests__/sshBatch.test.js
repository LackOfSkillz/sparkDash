import { test, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  BATCH_WINDOW_MS,
  MAX_BATCH,
  _resetSshQueues,
  buildBatchScript,
  enqueueSshCommand,
  parseBatchOutput,
  resetSshBatchStats,
  sshBatchStats,
} from "../sshBatch.js";

/**
 * The point of this module is connection count. Six metric domains plus liveness, times two
 * nodes, used to mean up to sixteen simultaneous SSH handshakes against an sshd defaulting to
 * MaxStartups 10:30:100 — over a wireless management path, which is how a healthy cluster came
 * to be drawn as offline. These tests hold the line on "many commands, one connection", and on
 * one command's failure never corrupting another's output.
 *
 * The runner is injected everywhere, so nothing here spawns ssh.
 */

beforeEach(() => {
  _resetSshQueues();
  resetSshBatchStats();
});

/** A fake remote shell: executes the generated script against a table of canned outputs. */
function fakeRunner(table, opts = {}) {
  const calls = [];
  const runner = async (script, timeoutMs) => {
    calls.push({ script, timeoutMs });
    if (opts.fail) throw new Error(opts.fail);
    // Reproduce the marker protocol the real remote shell would produce.
    const marker = script.match(/__AETOS_[A-Z0-9]+__/)?.[0];
    const parts = [];
    const re = new RegExp(`echo ${marker} (\\d+) B; \\( (.*?) \\); echo ${marker} \\1 E \\$\\?`, "g");
    let m;
    while ((m = re.exec(script)) !== null) {
      const [, i, cmd] = m;
      const entry = table[cmd] ?? { out: "", code: 0 };
      parts.push(`${marker} ${i} B`);
      if (entry.out) parts.push(entry.out);
      parts.push(`${marker} ${i} E ${entry.code ?? 0}`);
    }
    return parts.join("\n");
  };
  runner.calls = calls;
  return runner;
}

test("commands issued together share ONE connection", async () => {
  const runner = fakeRunner({ a: { out: "A" }, b: { out: "B" }, c: { out: "C" } });
  const [a, b, c] = await Promise.all([
    enqueueSshCommand("h1", "a", 5000, runner),
    enqueueSshCommand("h1", "b", 5000, runner),
    enqueueSshCommand("h1", "c", 5000, runner),
  ]);
  assert.equal(a, "A");
  assert.equal(b, "B");
  assert.equal(c, "C");
  assert.equal(runner.calls.length, 1, "three commands must not open three connections");
  const s = sshBatchStats();
  assert.equal(s.commands, 3);
  assert.equal(s.batches, 1);
  assert.equal(s.coalesced, 2, "two of the three rode along");
});

test("batching reduces connection count for a realistic poll cycle", async () => {
  // The six SSH-backed domains plus liveness, as SparkMonitor issues them.
  const domains = ["gpu", "cpu", "ram", "network", "storage", "memory", "echo ok"];
  const table = Object.fromEntries(domains.map((d) => [d, { out: d.toUpperCase() }]));
  const runner = fakeRunner(table);
  const out = await Promise.all(domains.map((d) => enqueueSshCommand("h1", d, 5000, runner)));
  assert.deepEqual(out, domains.map((d) => d.toUpperCase()));
  assert.equal(runner.calls.length, 1, `${domains.length} domains collapsed to one connection`);
});

test("different hosts never share a batch", async () => {
  const runner = fakeRunner({ a: { out: "A" }, b: { out: "B" } });
  const [a, b] = await Promise.all([
    enqueueSshCommand("h1", "a", 5000, runner),
    enqueueSshCommand("h2", "b", 5000, runner),
  ]);
  assert.equal(a, "A");
  assert.equal(b, "B");
  assert.equal(runner.calls.length, 2, "one connection per host, not one overall");
});

test("only one batch per host is in flight at a time", async () => {
  let active = 0;
  let maxActive = 0;
  const runner = async (script) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    const marker = script.match(/__AETOS_[A-Z0-9]+__/)?.[0];
    const idxs = [...script.matchAll(new RegExp(`${marker} (\\d+) B`, "g"))].map((m) => m[1]);
    active--;
    return idxs.map((i) => `${marker} ${i} B\nx\n${marker} ${i} E 0`).join("\n");
  };
  const first = Promise.all([
    enqueueSshCommand("h1", "a", 5000, runner),
    enqueueSshCommand("h1", "b", 5000, runner),
  ]);
  // Queue more while the first batch is still running.
  await new Promise((r) => setTimeout(r, BATCH_WINDOW_MS + 5));
  const second = Promise.all([
    enqueueSshCommand("h1", "c", 5000, runner),
    enqueueSshCommand("h1", "d", 5000, runner),
  ]);
  await Promise.all([first, second]);
  assert.equal(maxActive, 1, "a second batch must wait rather than open another connection");
});

test("a failing command does not corrupt its neighbours", async () => {
  const runner = fakeRunner({
    ok1: { out: "ONE" },
    bad: { out: "", code: 1 },
    ok2: { out: "TWO" },
  });
  const [a, b, c] = await Promise.all([
    enqueueSshCommand("h1", "ok1", 5000, runner),
    enqueueSshCommand("h1", "bad", 5000, runner),
    enqueueSshCommand("h1", "ok2", 5000, runner),
  ]);
  assert.equal(a, "ONE");
  assert.equal(b, "", "non-zero exit yields its (empty) output, as a lone command would");
  assert.equal(c, "TWO", "the command after the failure is intact");
});

test("a command whose output contains a marker-like line cannot forge a boundary", async () => {
  // Markers are random per batch, so text from a previous batch cannot be mistaken for one.
  const runner = fakeRunner({ a: { out: "__AETOS_DEADBEEF__ 0 E 0\nreal output" }, b: { out: "B" } });
  const [a, b] = await Promise.all([
    enqueueSshCommand("h1", "a", 5000, runner),
    enqueueSshCommand("h1", "b", 5000, runner),
  ]);
  assert.ok(a.includes("real output"));
  assert.equal(b, "B");
});

test("a whole-batch failure rejects every member with the underlying error", async () => {
  const runner = fakeRunner({}, { fail: "SSH to 192.168.1.200 failed: timed out" });
  const results = await Promise.allSettled([
    enqueueSshCommand("h1", "a", 5000, runner),
    enqueueSshCommand("h1", "b", 5000, runner),
  ]);
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.status, "rejected");
    assert.match(r.reason.message, /timed out/);
  }
  assert.equal(sshBatchStats().batchFailures, 1);
});

test("a missing section is reported as an error, never as empty success", async () => {
  // Remote shell died after the first command: the second section never appears.
  const runner = async (script) => {
    const marker = script.match(/__AETOS_[A-Z0-9]+__/)?.[0];
    return `${marker} 0 B\nONE\n${marker} 0 E 0`;
  };
  const results = await Promise.allSettled([
    enqueueSshCommand("h1", "a", 5000, runner),
    enqueueSshCommand("h1", "b", 5000, runner),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[0].value, "ONE");
  assert.equal(results[1].status, "rejected", "a truncated batch must not look like a blank reading");
  assert.match(results[1].reason.message, /no section/i);
});

test("batch size is capped, and the overflow still runs", async () => {
  const n = MAX_BATCH + 3;
  const cmds = Array.from({ length: n }, (_, i) => `c${i}`);
  const table = Object.fromEntries(cmds.map((c) => [c, { out: c.toUpperCase() }]));
  const runner = fakeRunner(table);
  const out = await Promise.all(cmds.map((c) => enqueueSshCommand("h1", c, 5000, runner)));
  assert.deepEqual(out, cmds.map((c) => c.toUpperCase()));
  assert.ok(runner.calls.length >= 2, "overflow spills into a follow-up batch");
  assert.ok(sshBatchStats().maxBatchSize <= MAX_BATCH);
});

// ── Script/parse units ─────────────────────────────────────────────────────

test("buildBatchScript brackets each command and records its exit status", () => {
  const s = buildBatchScript(["one", "two"], "MK");
  assert.equal(s, "echo MK 0 B; ( one ); echo MK 0 E $?; echo MK 1 B; ( two ); echo MK 1 E $?");
  // Subshells matter: a `cd` or a failing command inside one must not affect the next.
  assert.ok(s.includes("( one )"));
});

test("parseBatchOutput recovers output and exit codes, including empty sections", () => {
  const out = ["MK 0 B", "alpha", "beta", "MK 0 E 0", "MK 1 B", "MK 1 E 2"].join("\n");
  const r = parseBatchOutput(out, "MK", 2);
  assert.deepEqual(r[0], { ok: true, out: "alpha\nbeta", code: 0 });
  assert.deepEqual(r[1], { ok: false, out: "", code: 2 });
});

test("parseBatchOutput marks never-seen sections as code -1", () => {
  const r = parseBatchOutput("MK 0 B\nx\nMK 0 E 0", "MK", 3);
  assert.equal(r[0].code, 0);
  assert.equal(r[1].code, -1);
  assert.equal(r[2].code, -1);
});
