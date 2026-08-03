/**
 * Showcase size limits and body accounting.
 *
 * The old rule was one constant: `MAX_PROMPT_LEN = 4000`, measured in JavaScript
 * characters. That made the feature unusable for its new purpose — a real
 * LineWright prompt carries an entire scene manuscript and runs to tens or
 * hundreds of kilobytes — and it measured the wrong thing, since a curly quote
 * or an em dash is one character and three bytes.
 *
 * Raising it is not simply a matter of a bigger number. The archive path
 * serialized every prompt and every output into ONE monolithic JSON file and
 * rewrote the whole thing on every archive. At 4 MiB per prompt, 32 prompts, and
 * 20 retained runs, prompt text alone reaches ~2.5 GiB — past Node's maximum
 * string length (536,870,888 chars), so `JSON.stringify` would THROW, the
 * existing try/catch would log "failed to save history", and persistence would
 * stop silently.
 *
 * So there are two independent budgets here, and they exist for different
 * reasons:
 *
 *   REQUEST budget   — what a run may send.    Per-prompt and per-session.
 *   ARCHIVE budget   — what a run may persist. Per-session body.
 *
 * A run may legitimately exceed the archive budget and still be worth running;
 * it is then archived as metadata only. That is the honest outcome: a truncated
 * prompt presented as complete would be worse than none.
 */

const MiB = 1024 * 1024;

/**
 * Read a positive-integer byte/count limit from the environment.
 * Absent, unparseable, zero, or negative values fall back to the default —
 * a typo in a deployment env must not silently remove a safety limit.
 */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.warn(
      `[Showcase] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`
    );
    return fallback;
  }
  return n;
}

/** UTF-8 byte length. Never `String.length`, which counts UTF-16 code units. */
export function byteLength(text) {
  return Buffer.byteLength(typeof text === "string" ? text : "", "utf8");
}

export const SHOWCASE_LIMITS = Object.freeze({
  /** Largest single prompt a session may carry. */
  maxPromptBytes: envInt("SHOWCASE_MAX_PROMPT_BYTES", 4 * MiB),
  /**
   * Largest combined prompt input for one session.
   *
   * NOT maxPromptBytes × maxPrompts. A 4 MiB per-prompt ceiling does not entitle
   * a caller to 32 of them at once; this limit is what stops that.
   */
  maxSessionPromptBytes: envInt("SHOWCASE_MAX_SESSION_PROMPT_BYTES", 16 * MiB),
  /**
   * Largest total body (prompts + content + reasoning) that may be persisted for
   * one archived run. Above this the run is archived as metadata only.
   */
  maxHistoryBodyBytes: envInt("SHOWCASE_MAX_HISTORY_BODY_BYTES", 1 * MiB),
  /** Retained runs per Spark. */
  historyLimit: envInt("SHOWCASE_HISTORY_LIMIT", 20),
  /** Concurrent streams per session. */
  maxPrompts: envInt("SHOWCASE_MAX_PROMPTS", 32),
});

/**
 * Express body ceiling for the Showcase start route.
 *
 * The global `express.json()` default is 100 kb, so before this a 4 MiB prompt
 * was rejected as a generic 413 by the body parser and never reached the
 * Showcase validator — the caller learned nothing about which limit they hit.
 * Headroom covers JSON escaping and the non-prompt fields; the authoritative
 * check is still the byte validation in the manager.
 */
export const SHOWCASE_BODY_LIMIT_BYTES = SHOWCASE_LIMITS.maxSessionPromptBytes * 2;

/**
 * Measure the body a session would persist.
 *
 * Exact UTF-8 bytes of the text itself, deliberately NOT the length of its JSON
 * encoding. Escaping overhead varies with content — a prompt full of quotes and
 * newlines inflates more than plain prose — and a policy whose threshold moved
 * with punctuation would be impossible to reason about. Escaping is reported
 * separately for auditing.
 */
export function measureSessionBody(streams) {
  let promptBytes = 0;
  let contentBytes = 0;
  let reasoningBytes = 0;
  for (const s of streams || []) {
    promptBytes += byteLength(s?.prompt);
    contentBytes += byteLength(s?.content);
    reasoningBytes += byteLength(s?.reasoning);
  }
  return {
    promptBytes,
    contentBytes,
    reasoningBytes,
    totalBodyBytes: promptBytes + contentBytes + reasoningBytes,
  };
}

/**
 * Validate the request budget for a set of prompts.
 *
 * Returns `{ ok: true, totalBytes, perPrompt }` or `{ ok: false, error }`.
 * The error names the limit and the actual count and NEVER echoes prompt
 * content — an error message is a log line, and a log line is not where a
 * manuscript belongs.
 */
export function validatePromptBytes(prompts, limits = SHOWCASE_LIMITS) {
  const perPrompt = [];
  let totalBytes = 0;
  for (let i = 0; i < prompts.length; i++) {
    const bytes = byteLength(prompts[i]);
    perPrompt.push(bytes);
    totalBytes += bytes;
    if (bytes > limits.maxPromptBytes) {
      return {
        ok: false,
        error:
          `Prompt ${i + 1} is ${bytes.toLocaleString()} bytes; the configured ` +
          `per-prompt limit is ${limits.maxPromptBytes.toLocaleString()} bytes.`,
      };
    }
  }
  if (totalBytes > limits.maxSessionPromptBytes) {
    return {
      ok: false,
      error:
        `Combined prompt input is ${totalBytes.toLocaleString()} bytes; the ` +
        `configured session limit is ${limits.maxSessionPromptBytes.toLocaleString()} bytes.`,
    };
  }
  return { ok: true, totalBytes, perPrompt };
}
