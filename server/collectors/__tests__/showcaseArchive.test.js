import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ShowcaseManager,
  buildPromptIdentity,
  hashPromptBytes,
  withFillToMaxInstruction,
} from "../ShowcaseManager.js";
import { safeIdSegment } from "../showcaseRunStore.js";

/**
 * Showcase archival.
 *
 * The defect being fixed: every prompt and every output for the last 20 runs of
 * every Spark lived in ONE JSON file, rewritten in full on each archive. At real
 * LineWright prompt sizes that file reaches gigabytes — past Node's maximum
 * string length, so the write throws, the existing catch logs, and persistence
 * stops silently. Bodies now live in per-run files, and only when they fit.
 */

function tempManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showcase-test-"));
  const historyPath = path.join(dir, "showcase-history.json");
  const runsDir = path.join(dir, "showcase-runs");
  const mgr = new ShowcaseManager(historyPath, runsDir);
  return { mgr, dir, historyPath, runsDir };
}

/** A finished session shell, bypassing the network entirely. */
function finishedSession(sparkId, sessionId, streams, over = {}) {
  return {
    sessionId, sparkId, status: "completed", rev: 1, port: 8888,
    modelId: "test-model", maxTokens: 512, temperature: 0.7, thinking: false,
    promptType: null, raw: false, startedAt: 1, completedAt: 2,
    serverGenerationTps: null, serverGenerationTpsMax: null, serverGenerationSamples: 0,
    error: null,
    streams: streams.map((s, i) => ({
      streamId: String(i), label: (s.prompt || "").slice(0, 20), prompt: s.prompt,
      promptIdentity: buildPromptIdentity(s.prompt, s.prompt),
      status: "completed", content: s.content ?? "", reasoning: s.reasoning ?? "",
      contentLength: (s.content ?? "").length, reasoningLength: (s.reasoning ?? "").length,
      tokenCount: 10, ttftMs: 5, decodeTps: 20, liveTokPerSec: 20, peakTokPerSec: 25,
      model: "test-model", error: null,
    })),
    ...over,
  };
}

const readIndex = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// ---------------------------------------------------------------------------
// Archive threshold
// ---------------------------------------------------------------------------

test("a small session retains its bodies in a per-run file", () => {
  const { mgr, historyPath, runsDir } = tempManager();
  const PAD = "Lead-in text that fills the label window. ";
  mgr._archiveSession(finishedSession("spark-a", "s1", [
    { prompt: PAD + "PROMPT-BODY-MARKER", content: PAD + "OUTPUT-BODY-MARKER" },
  ]));

  const summary = mgr.getHistory("spark-a")[0];
  assert.equal(summary.bodyRetention.state, "full");
  assert.ok(summary.bodyRetention.retainedBytes > 0);

  const runFile = path.join(runsDir, "spark-a", "s1.json");
  assert.ok(fs.existsSync(runFile), "the run body file must exist");

  // The full session is reassembled from index + body file.
  const full = mgr.getHistorySession("spark-a", "s1");
  assert.equal(full.streams.length, 1);
  assert.equal(full.streams[0].prompt, PAD + "PROMPT-BODY-MARKER");
  assert.equal(full.streams[0].content, PAD + "OUTPUT-BODY-MARKER");

  // ...and the index does NOT duplicate them.
  const raw = fs.readFileSync(historyPath, "utf8");
  assert.ok(!raw.includes("PROMPT-BODY-MARKER"), "index must not carry the prompt body");
  assert.ok(!raw.includes("OUTPUT-BODY-MARKER"), "index must not carry the output body");
});

test("an oversized session archives metadata only and writes no body file", () => {
  const { mgr, historyPath, runsDir } = tempManager();
  const PROMPT = "Lead-in text that fills the label window. MANUSCRIPT-BODY-" + "x".repeat(2 * 1024 * 1024);
  const CONTENT = "Lead-in. OUTPUT-BODY-" + "y".repeat(1024);
  mgr._archiveSession(finishedSession("spark-a", "big", [
    { prompt: PROMPT, content: CONTENT, reasoning: "REASONING-BODY-zzz" },
  ]));

  const summary = mgr.getHistory("spark-a")[0];
  assert.equal(summary.bodyRetention.state, "metadata-only");
  assert.equal(summary.bodyRetention.reason, "session-body-limit");
  assert.equal(summary.bodyRetention.retainedBytes, 0);
  assert.ok(summary.bodyRetention.originalBytes > 2 * 1024 * 1024);

  assert.ok(!fs.existsSync(path.join(runsDir, "spark-a", "big.json")),
    "no body file may be written for an oversized run");

  // THE load-bearing storage regression: no body text anywhere in the index.
  const raw = fs.readFileSync(historyPath, "utf8");
  assert.ok(!raw.includes("MANUSCRIPT-BODY"), "index must not contain the prompt body");
  assert.ok(!raw.includes("OUTPUT-BODY"), "index must not contain the output body");
  assert.ok(!raw.includes("REASONING-BODY"), "index must not contain the reasoning body");
  assert.ok(raw.length < 8_000,
    `index must stay small; was ${raw.length} bytes for a 2 MiB run`);

  // Hashes and byte counts survive, so the run is still identifiable.
  const meta = readIndex(historyPath)["spark-a"][0].streamMeta[0];
  assert.equal(meta.promptIdentity.submittedHash, hashPromptBytes(PROMPT));
  assert.equal(meta.promptByteLength, Buffer.byteLength(PROMPT, "utf8"));
});

test("metadata-only sessions report empty streams, not fabricated ones", () => {
  const { mgr } = tempManager();
  mgr._archiveSession(finishedSession("spark-a", "big", [
    { prompt: "z".repeat(2 * 1024 * 1024), content: "out" },
  ]));
  const full = mgr.getHistorySession("spark-a", "big");
  assert.deepEqual(full.streams, [], "no bodies were kept, so none are returned");
  assert.equal(full.bodyRetention.state, "metadata-only");
  assert.equal(full.streamCount, 1, "but the run is still known to have had a stream");
});

test("the archive boundary is exact: at the limit retained, one byte over not", () => {
  const LIMIT = 1024 * 1024;
  for (const [bytes, expected] of [[LIMIT, "full"], [LIMIT + 1, "metadata-only"]]) {
    const { mgr } = tempManager();
    mgr._archiveSession(finishedSession("spark-a", "edge", [
      { prompt: "x".repeat(bytes), content: "" },
    ]));
    assert.equal(mgr.getHistory("spark-a")[0].bodyRetention.state, expected,
      `${bytes} bytes should be ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test("clearing history deletes that Spark's run files and leaves others intact", () => {
  const { mgr, runsDir } = tempManager();
  mgr._archiveSession(finishedSession("spark-a", "s1", [{ prompt: "a", content: "a" }]));
  mgr._archiveSession(finishedSession("spark-b", "s2", [{ prompt: "b", content: "b" }]));
  assert.ok(fs.existsSync(path.join(runsDir, "spark-a", "s1.json")));
  assert.ok(fs.existsSync(path.join(runsDir, "spark-b", "s2.json")));

  mgr.clearHistory("spark-a");
  assert.ok(!fs.existsSync(path.join(runsDir, "spark-a", "s1.json")), "own runs removed");
  assert.ok(fs.existsSync(path.join(runsDir, "spark-b", "s2.json")), "other Spark untouched");
  assert.equal(mgr.getHistory("spark-a").length, 0);
  assert.equal(mgr.getHistory("spark-b").length, 1);
});

test("retention eviction deletes the evicted run's body file", () => {
  const { mgr, runsDir } = tempManager();
  const limit = mgr.getHistory.length; // unused; retention limit read below
  const HISTORY_LIMIT = 20;
  for (let i = 0; i < HISTORY_LIMIT + 1; i++) {
    mgr._archiveSession(finishedSession("spark-a", `s${i}`, [{ prompt: `p${i}`, content: "c" }]));
  }
  assert.equal(mgr.getHistory("spark-a").length, HISTORY_LIMIT);
  // s0 was the oldest and is gone from the index; its file must be gone too.
  assert.ok(!fs.existsSync(path.join(runsDir, "spark-a", "s0.json")),
    "an evicted run must not orphan its body file");
  assert.ok(fs.existsSync(path.join(runsDir, "spark-a", `s${HISTORY_LIMIT}.json`)));
  assert.equal(fs.readdirSync(path.join(runsDir, "spark-a")).length, HISTORY_LIMIT);
  void limit;
});

test("re-archiving the same session id is idempotent", () => {
  const { mgr, runsDir } = tempManager();
  const s = finishedSession("spark-a", "same", [{ prompt: "p", content: "c" }]);
  mgr._archiveSession(s);
  mgr._archiveSession(s);
  mgr._archiveSession(s);
  assert.equal(mgr.getHistory("spark-a").length, 1);
  assert.equal(fs.readdirSync(path.join(runsDir, "spark-a")).length, 1);
});

test("a run that grows past the limit on re-archive drops its stale body file", () => {
  const { mgr, runsDir } = tempManager();
  mgr._archiveSession(finishedSession("spark-a", "grow", [{ prompt: "small", content: "" }]));
  assert.ok(fs.existsSync(path.join(runsDir, "spark-a", "grow.json")));
  mgr._archiveSession(finishedSession("spark-a", "grow", [
    { prompt: "x".repeat(2 * 1024 * 1024), content: "" },
  ]));
  assert.equal(mgr.getHistory("spark-a")[0].bodyRetention.state, "metadata-only");
  assert.ok(!fs.existsSync(path.join(runsDir, "spark-a", "grow.json")),
    "a metadata-only record must not leave a full body beside it");
});

// ---------------------------------------------------------------------------
// Damaged storage
// ---------------------------------------------------------------------------

test("a missing run file degrades to unavailable rather than crashing", () => {
  const { mgr, runsDir } = tempManager();
  mgr._archiveSession(finishedSession("spark-a", "s1", [{ prompt: "p", content: "c" }]));
  fs.rmSync(path.join(runsDir, "spark-a", "s1.json"));

  const full = mgr.getHistorySession("spark-a", "s1");
  assert.equal(full.bodyRetention.state, "unavailable");
  assert.equal(full.bodyRetention.reason, "run-file-missing-or-unreadable");
  assert.deepEqual(full.streams, []);
  assert.equal(mgr.getHistory("spark-a").length, 1, "the index entry survives");
});

test("a malformed run file does not destroy the index", () => {
  const { mgr, runsDir } = tempManager();
  mgr._archiveSession(finishedSession("spark-a", "s1", [{ prompt: "p", content: "c" }]));
  fs.writeFileSync(path.join(runsDir, "spark-a", "s1.json"), "{ not json");

  const full = mgr.getHistorySession("spark-a", "s1");
  assert.equal(full.bodyRetention.state, "unavailable");
  assert.equal(mgr.getHistory("spark-a").length, 1);
});

test("a legacy inline-body index is migrated out of the index on load", () => {
  const { dir } = tempManager();
  const historyPath = path.join(dir, "legacy-history.json");
  const runsDir = path.join(dir, "legacy-runs");
  fs.writeFileSync(historyPath, JSON.stringify({
    "spark-a": [{
      sessionId: "old", sparkId: "spark-a", status: "completed", port: 8888,
      streams: [{ streamId: "0", label: "l", prompt: "LEGACY-PROMPT", content: "LEGACY-OUT" }],
    }],
  }));

  const mgr = new ShowcaseManager(historyPath, runsDir);
  assert.equal(mgr.getHistory("spark-a")[0].bodyRetention.state, "legacy-inline");
  assert.equal(mgr.getHistorySession("spark-a", "old").streams[0].prompt, "LEGACY-PROMPT");
  // Importing this module builds its singleton, so construction must never
  // write. The on-disk index is untouched until something is archived.
  assert.ok(fs.readFileSync(historyPath, "utf8").includes("LEGACY-PROMPT"),
    "loading must not rewrite the index");
  mgr._archiveSession({ sessionId: "new", sparkId: "spark-a", status: "completed",
    streams: [{ streamId: "0", label: "n", prompt: "p", content: "c" }] });
  assert.ok(!fs.readFileSync(historyPath, "utf8").includes("LEGACY-PROMPT"),
    "the next archive sheds the inline bodies");
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

test("id segments cannot escape the runs directory", () => {
  assert.equal(safeIdSegment("../../etc/passwd"), "______etc_passwd");
  assert.equal(safeIdSegment("/absolute"), "_absolute");
  assert.equal(safeIdSegment(".."), "__");
  assert.equal(safeIdSegment(""), "_");
  assert.equal(safeIdSegment(null), "_");
  assert.equal(safeIdSegment("gx10-9141"), "gx10-9141");
  assert.ok(!safeIdSegment("a/../b").includes("/"));
});

test("a traversal-shaped spark id writes inside the runs root", () => {
  const { mgr, runsDir } = tempManager();
  mgr._archiveSession(finishedSession("../escape", "s1", [{ prompt: "p", content: "c" }]));
  const written = fs.readdirSync(runsDir);
  assert.deepEqual(written, ["___escape"], "the directory is sanitized, not traversed");
});

// ---------------------------------------------------------------------------
// Prompt identity
// ---------------------------------------------------------------------------

test("identical prompts hash identically; one byte apart do not", () => {
  assert.equal(hashPromptBytes("The lighthouse held."), hashPromptBytes("The lighthouse held."));
  assert.notEqual(hashPromptBytes("The lighthouse held."), hashPromptBytes("The lighthouse held!"));
  assert.match(hashPromptBytes("x"), /^[0-9a-f]{64}$/);
});

test("raw identity: submitted equals effective and nothing is marked mutated", () => {
  const p = "Exact prompt.";
  const id = buildPromptIdentity(p, p);
  assert.equal(id.submittedHash, id.effectiveHash);
  assert.equal(id.mutated, false);
  assert.equal(id.submittedByteLength, Buffer.byteLength(p, "utf8"));
});

test("non-raw identity: the fill suffix makes the hashes differ, and says so", () => {
  const p = "Write a scene.";
  const id = buildPromptIdentity(p, withFillToMaxInstruction(p));
  assert.notEqual(id.submittedHash, id.effectiveHash);
  assert.equal(id.mutated, true);
  assert.ok(id.effectiveByteLength > id.submittedByteLength);
});

test("byte lengths in identity are UTF-8, not character counts", () => {
  const p = "Merril said, “No.” 桜";
  const id = buildPromptIdentity(p, p);
  assert.equal(id.submittedByteLength, Buffer.byteLength(p, "utf8"));
  assert.ok(id.submittedByteLength > p.length);
});
