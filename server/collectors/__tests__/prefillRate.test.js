import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

/**
 * Effective prefill rate.
 *
 * vLLM credits prompt_tokens_total when a request is ADMITTED, not when its prefill finishes,
 * so the jump cannot be timed against the poll interval: that reported prompt_tokens / 2s,
 * measured at 39,584 tok/s for an 80K prompt whose real effective rate was near 1,600, and
 * non-zero in only 3 of 112 samples.
 *
 * Pairing tokens to TTFT observations inside a window was tried and abandoned. Admission and
 * first token land in different polls, and a request that never yields a first token — the
 * empty-completion fault seen on this cluster — leaves tokens no observation will ever pair
 * with, which then corrupt every later reading (measured 15,102 / 115,087 / 185,797 tok/s
 * against a client-measured 326 / ~1,900 / 17,597).
 *
 * What is reported is the ratio of the two lifetime aggregates: prompt tokens admitted over
 * seconds spent reaching first token. It is an average, it moves slowly, and it cannot drift.
 */

function vllmProbe() {
  const p = new LlmProbe({ id: "t", lanIp: "127.0.0.1", ssh: {} }, 8888);
  p.backendType = "vllm";
  return p;
}

const body = ({ prompt, gen, running, ttftSum, ttftCount }) =>
  [
    `vllm:prompt_tokens_total{engine="0"} ${prompt}`,
    `vllm:generation_tokens_total{engine="0"} ${gen}`,
    `vllm:num_requests_running{engine="0"} ${running}`,
    `vllm:num_requests_waiting{engine="0"} 0`,
    `vllm:time_to_first_token_seconds_sum{engine="0"} ${ttftSum}`,
    `vllm:time_to_first_token_seconds_count{engine="0"} ${ttftCount}`,
  ].join("\n");

test("prefill is tokens over seconds spent prefilling, not tokens per poll", () => {
  const p = vllmProbe();
  // 80,000 tokens admitted, 50s spent reaching first token.
  p._applyVllmMetrics(body({ prompt: 80_000, gen: 1, running: 1, ttftSum: 50, ttftCount: 1 }), 2);
  assert.equal(p.prefillTps, 1600, "80,000 / 50s = 1,600 tok/s, not 40,000");
});

test("a warm cache shows a correspondingly higher rate", () => {
  const p = vllmProbe();
  p._applyVllmMetrics(body({ prompt: 80_000, gen: 1, running: 1, ttftSum: 5, ttftCount: 1 }), 2);
  assert.equal(p.prefillTps, 16_000);
});

test("the reading survives idle polls instead of collapsing to zero", () => {
  const p = vllmProbe();
  p._applyVllmMetrics(body({ prompt: 40_000, gen: 1, running: 1, ttftSum: 25, ttftCount: 1 }), 2);
  const during = p.prefillTps;
  assert.equal(during, 1600);
  for (let i = 0; i < 6; i++) {
    p._applyVllmMetrics(body({ prompt: 40_000, gen: 900, running: 0, ttftSum: 25, ttftCount: 1 }), 2);
  }
  assert.equal(p.prefillTps, during, "an idle poll must not blank a real measurement");
});

test("a request that never reaches a first token cannot corrupt the reading", () => {
  // The empty-completion fault: tokens admitted, no TTFT recorded. Under the old windowed
  // pairing those tokens waited and were later divided by an unrelated request's TTFT.
  const p = vllmProbe();
  p._applyVllmMetrics(body({ prompt: 40_000, gen: 1, running: 1, ttftSum: 20, ttftCount: 1 }), 2);
  assert.equal(p.prefillTps, 2000);

  // 40,000 more tokens admitted; no new TTFT observation ever arrives for them.
  p._applyVllmMetrics(body({ prompt: 80_000, gen: 900, running: 1, ttftSum: 20, ttftCount: 1 }), 2);
  // The average shifts by its own share (80,000/20 = 4,000) rather than exploding.
  assert.equal(p.prefillTps, 4000);
  assert.ok(p.prefillTps < 10_000, "an unpaired request must not produce a runaway rate");
});

test("no TTFT time recorded yet means no rate is claimed", () => {
  const p = vllmProbe();
  p._applyVllmMetrics(body({ prompt: 5_000, gen: 0, running: 1, ttftSum: 0, ttftCount: 0 }), 2);
  assert.equal(p.prefillTps, 0, "dividing by zero elapsed would invent a number");
});

test("generation tok/s remains an instantaneous per-poll rate", () => {
  const p = vllmProbe();
  p._applyVllmMetrics(body({ prompt: 0, gen: 0, running: 1, ttftSum: 0, ttftCount: 0 }), 1);
  p._applyVllmMetrics(body({ prompt: 0, gen: 40, running: 1, ttftSum: 0, ttftCount: 0 }), 1);
  assert.equal(p.generationTps, 40);
});

/**
 * The live companion figure. Same ratio, taken over a rolling window instead of the whole
 * server history, so it can return to zero. It sits beside generation tok/s in the header,
 * where a number that never falls back reads as "the engine is busy" when it is idle.
 */

test("live prefill reports the windowed rate while requests are completing", () => {
  const p = vllmProbe();
  p._applyVllmMetrics(body({ prompt: 0, gen: 0, running: 0, ttftSum: 0, ttftCount: 0 }), 1);
  // 40,000 tokens admitted and 20s of prefill recorded for them.
  p._applyVllmMetrics(body({ prompt: 40_000, gen: 1, running: 1, ttftSum: 20, ttftCount: 1 }), 1);
  assert.equal(p.prefillTpsLive, 2000);
});

test("live prefill falls back to zero once the window contains no prefill", () => {
  const p = vllmProbe();
  p._applyVllmMetrics(body({ prompt: 0, gen: 0, running: 0, ttftSum: 0, ttftCount: 0 }), 1);
  p._applyVllmMetrics(body({ prompt: 40_000, gen: 1, running: 1, ttftSum: 20, ttftCount: 1 }), 1);
  assert.equal(p.prefillTpsLive, 2000);

  // Idle: counters frozen. Poll past the 20s window.
  for (let i = 0; i < 25; i++) {
    p._applyVllmMetrics(body({ prompt: 40_000, gen: 900, running: 0, ttftSum: 20, ttftCount: 1 }), 1);
  }
  assert.equal(p.prefillTpsLive, 0, "an idle engine must not keep claiming an input rate");
  assert.equal(p.prefillTps, 2000, "the lifetime average is unaffected by idleness");
});

test("live prefill claims nothing while tokens are admitted but no first token has landed", () => {
  // Admission credits prompt_tokens_total immediately; TTFT is only recorded at first token.
  // Between those two moments there is no measured prefill time, so there is no rate to report.
  const p = vllmProbe();
  p._applyVllmMetrics(body({ prompt: 0, gen: 0, running: 0, ttftSum: 0, ttftCount: 0 }), 1);
  p._applyVllmMetrics(body({ prompt: 80_000, gen: 0, running: 1, ttftSum: 0, ttftCount: 0 }), 1);
  assert.equal(p.prefillTpsLive, 0, "80,000 / one poll would report tens of thousands of tok/s");
});

test("live prefill recovers after a window has rolled off", () => {
  const p = vllmProbe();
  p._applyVllmMetrics(body({ prompt: 0, gen: 0, running: 0, ttftSum: 0, ttftCount: 0 }), 1);
  p._applyVllmMetrics(body({ prompt: 40_000, gen: 1, running: 1, ttftSum: 20, ttftCount: 1 }), 1);
  for (let i = 0; i < 25; i++) {
    p._applyVllmMetrics(body({ prompt: 40_000, gen: 900, running: 0, ttftSum: 20, ttftCount: 1 }), 1);
  }
  assert.equal(p.prefillTpsLive, 0);
  // A second request: 10,000 more tokens over 4 more seconds of prefill.
  p._applyVllmMetrics(body({ prompt: 50_000, gen: 901, running: 1, ttftSum: 24, ttftCount: 2 }), 1);
  assert.equal(p.prefillTpsLive, 2500, "the new window measures the new request, not the old one");
});

test("a realistic server-lifetime scrape yields a plausible average", () => {
  // Real values read from the cluster: 1,163,986 prompt tokens over 453s of prefill.
  const p = vllmProbe();
  p._applyVllmMetrics(
    body({ prompt: 1_163_986, gen: 19_537, running: 0, ttftSum: 453, ttftCount: 47 }), 2);
  assert.ok(p.prefillTps > 2_000 && p.prefillTps < 3_500,
    `expected a few thousand tok/s, got ${p.prefillTps}`);
});
