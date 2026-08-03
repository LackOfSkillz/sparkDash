import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ShowcaseManager } from "../ShowcaseManager.js";

/**
 * Raw generation mode.
 *
 * The demo path mutates every prompt server-side (a fill-to-maximum sentence)
 * and forbids the model to stop (min_tokens == max_tokens, ignore_eos). That
 * produces a good wall of moving text and a completion the model was not allowed
 * to finish — fine for a throughput demo, useless for studying what a prompt
 * does. Raw mode sends exactly what was given and lets the model stop.
 *
 * These tests capture the request body without a network call, by stubbing
 * global fetch and cancelling immediately.
 */

function tempManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showcase-raw-"));
  return new ShowcaseManager(
    path.join(dir, "showcase-history.json"),
    path.join(dir, "showcase-runs")
  );
}

/** Start a session, capture the outgoing request bodies, then cancel. */
async function captureBodies(mgr, opts) {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    // A body with no SSE data ends the stream immediately.
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    };
  };
  try {
    const started = mgr.start({
      sparkId: "spark-a", lanIp: "127.0.0.1", port: 8888, modelId: "m",
      maxTokens: 128, temperature: 0.5, thinking: false, ...opts,
    });
    // Let the request bodies be constructed and dispatched.
    await new Promise((r) => setTimeout(r, 50));
    mgr.cancel("spark-a", started.sessionId, "test");
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = realFetch;
  }
  return bodies;
}

const FILL = /Continue generating until you hit the maximum output length/;

test("raw mode omits every forced-generation field", async () => {
  const mgr = tempManager();
  const [body] = await captureBodies(mgr, { raw: true, prompts: ["Write one sentence."] });
  assert.ok(body, "a request body was captured");
  assert.equal(body.min_tokens, undefined, "min_tokens must be absent");
  assert.equal(body.ignore_eos, undefined, "ignore_eos must be absent");
  assert.equal(body.stop, undefined, "a forced empty stop list must be absent");
  // max_tokens survives as a ceiling, not a target.
  assert.equal(body.max_tokens, 128);
  assert.equal(body.temperature, 0.5, "temperature is not silently changed");
  assert.equal(body.stream, true);
});

test("raw mode does not append the fill-to-maximum sentence", async () => {
  const mgr = tempManager();
  const prompt = "Write one sentence about a lighthouse.";
  const [body] = await captureBodies(mgr, { raw: true, prompts: [prompt] });
  assert.equal(body.messages[0].content, prompt);
  assert.ok(!FILL.test(body.messages[0].content));
});

test("raw mode preserves the exact submitted bytes", async () => {
  const mgr = tempManager();
  // Everything a real LineWright packet contains and the old path destroyed:
  // leading indentation, trailing whitespace, blank lines, CRLF, Unicode, and
  // text that looks like a compiler heading.
  const prompt =
    "   ## Task\r\n\r\nMerril said, “No.” 桜\n\n\t## Writer instruction\n\nContinue.   \n";
  const [body] = await captureBodies(mgr, { raw: true, prompts: [prompt] });
  assert.equal(body.messages[0].content, prompt, "byte-identical to what was submitted");
  assert.equal(
    Buffer.byteLength(body.messages[0].content, "utf8"),
    Buffer.byteLength(prompt, "utf8")
  );
  assert.ok(body.messages[0].content.startsWith("   "), "leading spaces survive");
  assert.ok(body.messages[0].content.endsWith("   \n"), "trailing whitespace survives");
  assert.ok(body.messages[0].content.includes("\r\n"), "CRLF survives");
});

test("non-raw mode is unchanged: suffix and forced fields both present", async () => {
  const mgr = tempManager();
  const [body] = await captureBodies(mgr, { prompts: ["Write one sentence."] });
  assert.match(body.messages[0].content, FILL);
  assert.equal(body.min_tokens, 128);
  assert.equal(body.ignore_eos, true);
  assert.deepEqual(body.stop, []);
});

test("non-raw mode still trims, as it always has", async () => {
  const mgr = tempManager();
  const [body] = await captureBodies(mgr, { prompts: ["   padded   "] });
  assert.ok(body.messages[0].content.startsWith("padded"));
});

test("raw is recorded on the session and survives into history", async () => {
  const mgr = tempManager();
  await captureBodies(mgr, { raw: true, prompts: ["Write one sentence."] });
  const summary = mgr.getHistory("spark-a")[0];
  assert.equal(summary.raw, true, "history must remember the run was raw");
  const full = mgr.getHistorySession("spark-a", summary.sessionId);
  assert.equal(full.raw, true, "so a reused run stays raw");
});

test("a non-raw run is recorded as non-raw", async () => {
  const mgr = tempManager();
  await captureBodies(mgr, { prompts: ["Write one sentence."] });
  assert.equal(mgr.getHistory("spark-a")[0].raw, false);
});

test("prompt identity distinguishes raw from mutated runs", async () => {
  const rawMgr = tempManager();
  await captureBodies(rawMgr, { raw: true, prompts: ["Write one sentence."] });
  const rawId = rawMgr
    .getHistory("spark-a")[0];
  const rawFull = rawMgr.getHistorySession("spark-a", rawId.sessionId);
  assert.equal(rawFull.streams[0].promptIdentity.mutated, false);
  assert.equal(
    rawFull.streams[0].promptIdentity.submittedHash,
    rawFull.streams[0].promptIdentity.effectiveHash
  );

  const demoMgr = tempManager();
  await captureBodies(demoMgr, { prompts: ["Write one sentence."] });
  const demoId = demoMgr.getHistory("spark-a")[0];
  const demoFull = demoMgr.getHistorySession("spark-a", demoId.sessionId);
  assert.equal(demoFull.streams[0].promptIdentity.mutated, true);
  assert.notEqual(
    demoFull.streams[0].promptIdentity.submittedHash,
    demoFull.streams[0].promptIdentity.effectiveHash
  );
});

test("a prompt far past the old 4,000-character ceiling is accepted", async () => {
  const mgr = tempManager();
  const big = "A realistic scene manuscript. ".repeat(4000); // ~120 KB
  assert.ok(big.length > 100_000);
  const [body] = await captureBodies(mgr, { raw: true, prompts: [big] });
  assert.equal(body.messages[0].content, big);
});

test("aggregate rejection names the limit and does not echo the prompt", () => {
  const mgr = tempManager();
  // 5 prompts of 4 MiB each: individually legal, collectively past 16 MiB.
  const prompts = Array.from({ length: 5 }, () => "SECRET-MANUSCRIPT" + "x".repeat(4 * 1024 * 1024 - 17));
  assert.throws(
    () => mgr.start({ sparkId: "spark-a", lanIp: "127.0.0.1", port: 8888, raw: true, prompts }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /Combined prompt input is [\d,]+ bytes/);
      assert.match(err.message, /session limit is 16,777,216 bytes/);
      assert.ok(!err.message.includes("SECRET-MANUSCRIPT"));
      return true;
    }
  );
});

test("a single prompt over the per-prompt limit names which one", () => {
  const mgr = tempManager();
  assert.throws(
    () => mgr.start({
      sparkId: "spark-a", lanIp: "127.0.0.1", port: 8888, raw: true,
      prompts: ["ok", "x".repeat(4 * 1024 * 1024 + 1)],
    }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /Prompt 2 is 4,194,305 bytes/);
      assert.match(err.message, /per-prompt limit is 4,194,304 bytes/);
      return true;
    }
  );
});
