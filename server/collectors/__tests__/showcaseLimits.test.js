import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  SHOWCASE_LIMITS,
  byteLength,
  measureSessionBody,
  validatePromptBytes,
} from "../showcaseLimits.js";

/**
 * Prompt size limits.
 *
 * The old rule was 4,000 JavaScript CHARACTERS, which failed twice over: a real
 * LineWright packet carries a whole scene manuscript, and a character count is
 * not a size — a curly quote is one character and three bytes.
 */

const limits = { maxPromptBytes: 100, maxSessionPromptBytes: 250 };

test("byteLength counts UTF-8 bytes, not UTF-16 code units", () => {
  assert.equal(byteLength("abc"), 3);
  // Curly quotes and CJK are 3 bytes each; an emoji is 4.
  assert.equal(byteLength("“"), 3);
  assert.equal(byteLength("桜"), 3);
  assert.equal(byteLength("🔥"), 4);
  const text = "Merril said, “No.” 桜";
  assert.equal(byteLength(text), Buffer.byteLength(text, "utf8"));
  assert.ok(byteLength(text) > text.length, "bytes must exceed character count here");
  assert.equal(byteLength(undefined), 0);
});

test("a prompt under the per-prompt limit is accepted", () => {
  const r = validatePromptBytes(["x".repeat(99)], limits);
  assert.equal(r.ok, true);
  assert.equal(r.totalBytes, 99);
});

test("a prompt exactly at the per-prompt limit is accepted", () => {
  assert.equal(validatePromptBytes(["x".repeat(100)], limits).ok, true);
});

test("one byte over the per-prompt limit is rejected", () => {
  const r = validatePromptBytes(["x".repeat(101)], limits);
  assert.equal(r.ok, false);
  assert.match(r.error, /Prompt 1 is 101 bytes/);
  assert.match(r.error, /per-prompt limit is 100 bytes/);
});

test("the limit is enforced in bytes, so multibyte text is measured correctly", () => {
  // 34 characters, 102 bytes — under the limit by characters, over by bytes.
  const multibyte = "桜".repeat(34);
  assert.ok(multibyte.length < limits.maxPromptBytes, "under the limit by character count");
  assert.equal(validatePromptBytes([multibyte], limits).ok, false);
});

test("prompts individually under the limit but collectively over it are rejected", () => {
  const r = validatePromptBytes(["x".repeat(90), "y".repeat(90), "z".repeat(90)], limits);
  assert.equal(r.ok, false);
  assert.match(r.error, /Combined prompt input is 270 bytes/);
  assert.match(r.error, /session limit is 250 bytes/);
});

test("the aggregate limit still applies at the maximum prompt count", () => {
  const many = Array.from({ length: 32 }, () => "x".repeat(50));
  const r = validatePromptBytes(many, limits);
  assert.equal(r.ok, false, "32 prompts of 50 bytes is 1,600 bytes, past the 250 limit");
});

test("an error never echoes prompt content", () => {
  const secret = "MANUSCRIPT-SECRET-" + "x".repeat(200);
  const r = validatePromptBytes([secret], limits);
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes("MANUSCRIPT-SECRET"), "the error must not carry the prompt");
});

test("measureSessionBody sums prompts, content, and reasoning in bytes", () => {
  const m = measureSessionBody([
    { prompt: "ab", content: "cde", reasoning: "f" },
    { prompt: "桜", content: "", reasoning: null },
  ]);
  assert.equal(m.promptBytes, 5); // 2 + 3
  assert.equal(m.contentBytes, 3);
  assert.equal(m.reasoningBytes, 1);
  assert.equal(m.totalBodyBytes, 9);
});

test("shipped defaults are explicit and ordered sensibly", () => {
  assert.equal(SHOWCASE_LIMITS.maxPromptBytes, 4 * 1024 * 1024);
  assert.equal(SHOWCASE_LIMITS.maxSessionPromptBytes, 16 * 1024 * 1024);
  assert.equal(SHOWCASE_LIMITS.maxHistoryBodyBytes, 1024 * 1024);
  // The aggregate limit is deliberately NOT maxPrompt × maxPrompts: a 4 MiB
  // per-prompt ceiling must not entitle a caller to 32 of them at once.
  assert.ok(
    SHOWCASE_LIMITS.maxSessionPromptBytes <
      SHOWCASE_LIMITS.maxPromptBytes * SHOWCASE_LIMITS.maxPrompts
  );
  // Archive budget is far below the request budget on purpose: what may be RUN
  // and what may be KEPT are different questions.
  assert.ok(SHOWCASE_LIMITS.maxHistoryBodyBytes < SHOWCASE_LIMITS.maxSessionPromptBytes);
});
