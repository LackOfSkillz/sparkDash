import { test } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import { createServer } from "node:http";
import {
  SHOWCASE_START_PATH,
  mountShowcaseBodyParser,
  showcaseBodyErrorHandler,
} from "../../showcaseBodyParser.js";
import { SHOWCASE_BODY_LIMIT_BYTES } from "../showcaseLimits.js";

/**
 * HTTP-level proof that a real LineWright packet reaches Showcase handling.
 *
 * Testing `ShowcaseManager.start()` with a big string proves nothing about this:
 * the manager is only reached if the request survives Express's middleware
 * chain, and the chain is where the defect was. `app.use(express.json())` is
 * registered near the top of server/index.js with a 100 kb default, and Express
 * runs middleware in REGISTRATION ORDER — so a scoped parser declared next to
 * the route lower down never ran. The global parser read the stream first and
 * rejected with a generic 413.
 *
 * These tests drive a real HTTP server over a real socket, using the same
 * mounting function server/index.js calls.
 */

/** Build a server that mirrors index.js's ordering. `brokenOrder` reproduces the bug. */
function buildApp({ brokenOrder = false } = {}) {
  const app = express();
  if (brokenOrder) {
    // What the code did before: global parser first, scoped parser at the route.
    app.use(express.json());
    app.post(SHOWCASE_START_PATH, express.json({ limit: SHOWCASE_BODY_LIMIT_BYTES }), handler);
  } else {
    mountShowcaseBodyParser(app, express);
    app.use(express.json());
    app.post(SHOWCASE_START_PATH, handler);
  }
  app.use(showcaseBodyErrorHandler());
  return app;

  // Stands in for the real route: proves the body arrived intact and that
  // Showcase-level validation is what decides the outcome.
  function handler(req, res) {
    const prompts = req.body?.prompts;
    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: "prompts must be a non-empty array" });
    }
    const bytes = prompts.reduce((n, p) => n + Buffer.byteLength(String(p), "utf8"), 0);
    if (bytes > 16 * 1024 * 1024) {
      return res.status(400).json({
        error: `Combined prompt input is ${bytes} bytes; the configured session limit is 16777216 bytes.`,
      });
    }
    return res.status(202).json({
      sessionId: "test-session",
      status: "running",
      receivedBytes: bytes,
      raw: req.body?.raw === true,
    });
  }
}

async function post(app, payload) {
  const server = createServer(app);
  // Keep-alive sockets outlive the response and leave server.close() pending,
  // which under full-suite load turned socket lifecycle into a test variable.
  // One request per server, closed explicitly.
  server.keepAliveTimeout = 0;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sparks/gx10-9141/llm/showcase`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* body may not be JSON */
    }
    return { status: res.status, json };
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/** A realistic LineWright packet: compiler headings plus a scene manuscript. */
function realisticPacket(approxBytes) {
  const head = "## Task\n\nContinue the scene.\n\n## Source text\n\n";
  const body = "The lighthouse held through the night, and the beam went on turning. ";
  const reps = Math.ceil((approxBytes - head.length) / body.length);
  return head + body.repeat(reps);
}

// ---------------------------------------------------------------------------

test("the OLD ordering rejects a real packet with a generic 413", async () => {
  // Reproduces the defect, so the fix below is measured against something real
  // rather than asserted.
  const prompt = realisticPacket(300 * 1024);
  const { status, json } = await post(buildApp({ brokenOrder: true }), {
    port: 8888, raw: true, prompts: [prompt],
  });
  assert.equal(status, 413, "global parser rejects before the route is reached");
  assert.ok(
    !json || !json.sessionId,
    "the request never reached Showcase handling under the old ordering"
  );
});

test("a 300 KB packet reaches Showcase handling and is accepted", async () => {
  const prompt = realisticPacket(300 * 1024);
  const bytes = Buffer.byteLength(prompt, "utf8");
  assert.ok(bytes > 250 * 1024 && bytes < 500 * 1024, `payload is ${bytes} bytes`);
  assert.ok(bytes > 100 * 1024, "and comfortably past the global parser's old 100 kb default");

  const { status, json } = await post(buildApp(), { port: 8888, raw: true, prompts: [prompt] });
  assert.equal(status, 202, "route reached; no generic 413");
  assert.equal(json.receivedBytes, bytes, "the body arrived intact, not truncated");
  assert.equal(json.raw, true, "raw mode survived the parser");
});

test("a 500 KB packet also reaches the route", async () => {
  const prompt = realisticPacket(500 * 1024);
  const { status, json } = await post(buildApp(), { port: 8888, raw: true, prompts: [prompt] });
  assert.equal(status, 202);
  assert.equal(json.receivedBytes, Buffer.byteLength(prompt, "utf8"));
});

test("a request past the Showcase session limit gets a Showcase 400, not a parser 413", async () => {
  // Under the session limit for the parser, over it for Showcase — the point is
  // that the SHOWCASE rule decides, and the caller is told which limit they hit.
  const prompt = realisticPacket(4 * 1024 * 1024);
  const { status, json } = await post(buildApp(), {
    port: 8888, raw: true, prompts: [prompt, prompt, prompt, prompt, prompt],
  });
  assert.equal(status, 400, "Showcase validation decided, not the body parser");
  assert.match(json.error, /Combined prompt input is \d+ bytes/);
  assert.match(json.error, /session limit/);
});

test("a body past the scoped parser limit is a sanitized 413", async () => {
  const oversized = "x".repeat(SHOWCASE_BODY_LIMIT_BYTES + 1024);
  const { status, json } = await post(buildApp(), { port: 8888, raw: true, prompts: [oversized] });
  assert.equal(status, 413);
  assert.match(json.error, /Showcase request body exceeds the configured limit/);
  // The prompt must not come back in the error.
  assert.ok(!json.error.includes("xxxx"), "the error must not echo body content");
});

test("malformed JSON is a sanitized 400, not a stack trace", async () => {
  const { status, json } = await post(buildApp(), '{"port": 8888, "prompts": [');
  assert.equal(status, 400);
  assert.match(json.error, /not valid JSON/);
  assert.ok(!/at \w+ \(/.test(JSON.stringify(json)), "no stack trace in the response");
});

test("the scoped parser does not raise the limit for other API routes", async () => {
  // A body limit that applied everywhere would turn one feature's need into a
  // denial-of-service surface across the whole API.
  const app = express();
  mountShowcaseBodyParser(app, express);
  app.use(express.json());
  app.post("/api/sparks/gx10-9141/wake", (req, res) => res.status(200).json({ ok: true }));
  app.use(showcaseBodyErrorHandler());

  const server = createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sparks/gx10-9141/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(300 * 1024) }),
    });
    assert.equal(res.status, 413, "other routes keep the small default limit");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("an ordinary small Showcase request still works", async () => {
  const { status, json } = await post(buildApp(), {
    port: 8888, prompts: ["Write a short scene."],
  });
  assert.equal(status, 202);
  assert.equal(json.raw, false);
});
