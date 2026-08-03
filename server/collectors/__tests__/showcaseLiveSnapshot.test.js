import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ShowcaseManager } from "../ShowcaseManager.js";

/**
 * The LIVE poll snapshot must carry the same facts as the archived record.
 *
 * `getSession()` builds its own object rather than reusing publicSessionRecord,
 * so fields added to archival do not appear on the live path automatically. That
 * gap is invisible until something reads it: the UI restores the Raw toggle from
 * the polled session, and a verification harness checks the prompt hash there,
 * and both silently saw `undefined`.
 */

function tempManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showcase-live-"));
  return new ShowcaseManager(
    path.join(dir, "showcase-history.json"),
    path.join(dir, "showcase-runs")
  );
}

/** Start a session against a stubbed fetch that ends the stream immediately. */
async function startStubbed(mgr, opts) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "text/event-stream" },
    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
  });
  try {
    const started = mgr.start({
      sparkId: "spark-a", lanIp: "127.0.0.1", port: 8888, modelId: "m",
      maxTokens: 128, temperature: 0, thinking: false, ...opts,
    });
    await new Promise((r) => setTimeout(r, 60));
    return started.sessionId;
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a live raw session reports raw:true on the poll snapshot", async () => {
  const mgr = tempManager();
  const sid = await startStubbed(mgr, { raw: true, prompts: ["Exact prompt."] });
  const live = mgr.getSession("spark-a", sid);
  assert.equal(live.raw, true, "the UI restores the Raw toggle from this field");
  assert.equal(live.fromHistory, false);
});

test("a live non-raw session reports raw:false", async () => {
  const mgr = tempManager();
  const sid = await startStubbed(mgr, { prompts: ["Exact prompt."] });
  assert.equal(mgr.getSession("spark-a", sid).raw, false);
});

test("prompt identity is present on the live snapshot, not only after archival", async () => {
  const mgr = tempManager();
  const sid = await startStubbed(mgr, { raw: true, prompts: ["Exact prompt."] });
  const id = mgr.getSession("spark-a", sid).streams[0].promptIdentity;
  assert.ok(id, "identity must be visible while the run is live");
  assert.equal(id.mutated, false);
  assert.equal(id.submittedHash, id.effectiveHash);
  assert.match(id.submittedHash, /^[0-9a-f]{64}$/);
});

test("identity survives a delta poll, so a late-joining client can still verify", async () => {
  const mgr = tempManager();
  const sid = await startStubbed(mgr, { raw: true, prompts: ["Exact prompt."] });
  const full = mgr.getSession("spark-a", sid);
  const delta = mgr.getSession("spark-a", sid, full.rev);
  assert.ok(delta.streams[0].promptIdentity, "identity is not a full-snapshot-only field");
  assert.equal(
    delta.streams[0].promptIdentity.submittedHash,
    full.streams[0].promptIdentity.submittedHash
  );
});

test("a non-raw live session reports the mutation honestly", async () => {
  const mgr = tempManager();
  const sid = await startStubbed(mgr, { prompts: ["Write a scene."] });
  const id = mgr.getSession("spark-a", sid).streams[0].promptIdentity;
  assert.equal(id.mutated, true, "the fill suffix altered the prompt and the record says so");
  assert.notEqual(id.submittedHash, id.effectiveHash);
});

test("promptType round-trips on the live snapshot", async () => {
  const mgr = tempManager();
  const sid = await startStubbed(mgr, { promptType: "text", prompts: ["Write a scene."] });
  assert.equal(mgr.getSession("spark-a", sid).promptType, "text");
});
