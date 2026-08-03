/**
 * ShowcaseManager — concurrent prompt showcase sessions.
 *
 * One active session per Spark. Finished runs are archived to
 * config/showcase-history.json (survives refresh / restart).
 * Live sessions use heartbeat via GET poll; auto-cancel if no touch ~5s.
 */

import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWrite } from "../util/atomicWrite.js";
import {
  SHOWCASE_LIMITS,
  byteLength,
  measureSessionBody,
  validatePromptBytes,
} from "./showcaseLimits.js";
import { ShowcaseRunStore } from "./showcaseRunStore.js";
import { decodeBenchManager } from "./DecodeBench.js";
import {
  applyThinkingFlags,
  pollServerGenerationRates,
  round2,
  runStreamingRequest,
} from "./LlmStreaming.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const HISTORY_PATH =
  process.env.SHOWCASE_HISTORY_PATH ||
  path.join(ROOT, "config", "showcase-history.json");
/**
 * Per-run body files live beside the index, in their own directory.
 * The index holds summaries and byte counts; bodies live here, one file per run,
 * and only when the run fits the archive budget.
 */
const RUNS_DIR =
  process.env.SHOWCASE_RUNS_DIR ||
  path.join(path.dirname(HISTORY_PATH), "showcase-runs");
/** Retained runs per Spark. */
const HISTORY_LIMIT = SHOWCASE_LIMITS.historyLimit;

const DEFAULT_MAX_TOKENS = 512;
const MIN_MAX_TOKENS = 64;
const MAX_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.7;
const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;
const MIN_PROMPTS = 1;
const MAX_PROMPTS = SHOWCASE_LIMITS.maxPrompts;
/**
 * Prompt size is enforced in UTF-8 BYTES by showcaseLimits, not in characters.
 * A prompt must still carry at least one non-whitespace character; that is a
 * "did you actually send something" check, not a size limit.
 */
const MIN_PROMPT_LEN = 1;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const HEARTBEAT_CHECK_MS = 1_000;
/** Full max_tokens fills at low tok/s need a longer per-stream budget than decode bench. */
const PER_REQUEST_TIMEOUT_MS = 360_000;
const LABEL_CHARS = 40;

/**
 * Cap accumulated content per stream at min(maxTokens * 16, 200_000) chars.
 * Generous vs ~4 chars/token so full max_tokens fills aren't clipped in the UI.
 * @param {number} maxTokens
 */
function contentCap(maxTokens) {
  return Math.min(Math.max(1, maxTokens) * 16, 200_000);
}

const PROMPT_TYPES = new Set(["structural", "text", "mixed"]);

/** Suffix appended server-side in NON-raw mode. Never appended in raw mode. */
const FILL_TO_MAX_SUFFIX =
  " Continue generating until you hit the maximum output length; do not stop early—keep expanding with more content.";

/**
 * SHA-256 of the exact UTF-8 bytes, lowercase hex.
 *
 * Proves BYTE IDENTITY and nothing else. It is not evidence of semantic
 * equivalence, model determinism, or that a provider served anything from a
 * cache. It answers exactly one question: are these the same bytes?
 */
export function hashPromptBytes(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/**
 * Identity of one prompt, before and after Showcase's own mutation.
 *
 * Non-raw mode appends the fill-to-maximum suffix server-side, so what the model
 * received is not what the caller typed. Recording only one hash would make the
 * run irreproducible from its own record: you could not tell whether a
 * difference came from your edit or from the server's. Two hashes, and a flag
 * that says plainly whether they diverged.
 */
export function buildPromptIdentity(submitted, effective) {
  const submittedHash = hashPromptBytes(submitted);
  const effectiveHash = submitted === effective ? submittedHash : hashPromptBytes(effective);
  return {
    submittedHash,
    submittedByteLength: byteLength(submitted),
    effectiveHash,
    effectiveByteLength: byteLength(effective),
    mutated: submitted !== effective,
  };
}

/**
 * Encourage full-length completions when the prompt doesn't already ask for it.
 * Only skip when the prompt already states the hard length/EOS rule — phrases like
 * "keep expanding" alone are not enough (models still stop at natural EOS).
 * @param {string} prompt
 */
export function withFillToMaxInstruction(prompt) {
  const p = String(prompt || "").trim();
  if (!p) return p;
  if (
    /maximum output length|do not stop early|until you hit the (maximum|output)/i.test(
      p
    )
  ) {
    return p;
  }
  return `${p}${FILL_TO_MAX_SUFFIX}`;
}

/** vLLM-oriented fields that some OpenAI-compat servers reject with HTTP 400. */
export function stripFillForceFields(body) {
  if (!body || typeof body !== "object") return body;
  const next = { ...body };
  delete next.min_tokens;
  delete next.ignore_eos;
  delete next.stop;
  return next;
}

function labelFromPrompt(prompt) {
  const s = String(prompt || "").replace(/\s+/g, " ").trim();
  if (s.length <= LABEL_CHARS) return s;
  return `${s.slice(0, LABEL_CHARS - 1)}…`;
}

function isTerminalStreamStatus(status) {
  return status === "completed" || status === "error" || status === "cancelled";
}

/**
 * Serialize a finished (or in-memory) session for history / public GET.
 * @param {object} session
 * @param {{ fromHistory?: boolean }} [opts]
 */
function publicSessionRecord(session, opts = {}) {
  const streams = (session.streams || []).map((s) => ({
    streamId: s.streamId,
    label: s.label,
    prompt: s.prompt,
    promptIdentity: s.promptIdentity ?? null,
    status: s.status,
    content: s.content || "",
    reasoning: s.reasoning || "",
    contentLength: s.contentLength ?? (s.content || "").length,
    reasoningLength: s.reasoningLength ?? (s.reasoning || "").length,
    tokenCount: s.tokenCount || 0,
    ttftMs: s.ttftMs ?? null,
    decodeTps: s.decodeTps || 0,
    liveTokPerSec: s.liveTokPerSec || s.decodeTps || 0,
    peakTokPerSec: s.peakTokPerSec || 0,
    model: s.model ?? null,
    error: s.error ?? null,
  }));

  const totalTokens = streams.reduce((sum, s) => sum + (s.tokenCount || 0), 0);
  const decodeRates = streams.map((s) => s.decodeTps || 0).filter((r) => r > 0);
  const meanDecodeTps =
    decodeRates.length > 0
      ? round2(decodeRates.reduce((a, b) => a + b, 0) / decodeRates.length)
      : 0;
  const peakStreamTps = streams.reduce(
    (m, s) => Math.max(m, s.peakTokPerSec || 0, s.decodeTps || 0),
    0
  );

  return {
    sessionId: session.sessionId,
    sparkId: session.sparkId,
    status: session.status,
    rev: session.rev ?? 0,
    port: session.port,
    modelId: session.modelId ?? null,
    maxTokens: session.maxTokens ?? null,
    temperature: session.temperature ?? DEFAULT_TEMPERATURE,
    thinking: session.thinking !== false,
    promptType: session.promptType ?? null,
    raw: session.raw === true,
    startedAt: session.startedAt ?? null,
    completedAt: session.completedAt ?? null,
    serverGenerationTps: session.serverGenerationTps ?? null,
    serverGenerationTpsMax: session.serverGenerationTpsMax ?? null,
    serverGenerationSamples: session.serverGenerationSamples ?? 0,
    totalTokens,
    meanDecodeTps,
    peakStreamTps,
    streamCount: streams.length,
    bodyAccounting: measureSessionBody(streams),
    streams,
    error: session.error ?? null,
    fromHistory: Boolean(opts.fromHistory || session.fromHistory),
  };
}

/**
 * The index entry for one archived run: everything EXCEPT the bodies.
 *
 * This is what makes the index cheap. Per stream it keeps identity, status, and
 * sizes — enough to tell two runs apart, verify a prompt, and audit storage —
 * and drops `prompt`, `content`, and `reasoning`, which are the only fields that
 * scale with the manuscript. Bodies live in one place: the run file, or nowhere.
 */
function historyIndexRecord(record, bodyRetention) {
  return {
    sessionId: record.sessionId,
    sparkId: record.sparkId,
    status: record.status,
    port: record.port,
    modelId: record.modelId ?? null,
    maxTokens: record.maxTokens ?? null,
    temperature: record.temperature ?? DEFAULT_TEMPERATURE,
    thinking: record.thinking !== false,
    promptType: record.promptType ?? null,
    raw: record.raw === true,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    serverGenerationTps: record.serverGenerationTps ?? null,
    serverGenerationTpsMax: record.serverGenerationTpsMax ?? null,
    serverGenerationSamples: record.serverGenerationSamples ?? 0,
    totalTokens: record.totalTokens ?? 0,
    meanDecodeTps: record.meanDecodeTps ?? 0,
    peakStreamTps: record.peakStreamTps ?? 0,
    streamCount: record.streamCount ?? record.streams?.length ?? 0,
    bodyAccounting: record.bodyAccounting ?? measureSessionBody(record.streams),
    bodyRetention,
    streamMeta: (record.streams || []).map((s) => ({
      streamId: s.streamId,
      label: s.label,
      status: s.status,
      promptIdentity: s.promptIdentity ?? null,
      promptByteLength: byteLength(s.prompt),
      contentByteLength: byteLength(s.content),
      reasoningByteLength: byteLength(s.reasoning),
      tokenCount: s.tokenCount || 0,
      ttftMs: s.ttftMs ?? null,
      decodeTps: s.decodeTps || 0,
      peakTokPerSec: s.peakTokPerSec || 0,
      model: s.model ?? null,
      error: s.error ?? null,
    })),
    error: record.error ?? null,
    fromHistory: true,
  };
}

/** Lightweight list row (no stream bodies). */
function historySummary(record) {
  return {
    sessionId: record.sessionId,
    sparkId: record.sparkId,
    status: record.status,
    port: record.port,
    modelId: record.modelId ?? null,
    maxTokens: record.maxTokens ?? null,
    temperature: record.temperature ?? DEFAULT_TEMPERATURE,
    thinking: record.thinking !== false,
    promptType: record.promptType ?? null,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    serverGenerationTps: record.serverGenerationTps ?? null,
    serverGenerationTpsMax: record.serverGenerationTpsMax ?? null,
    totalTokens: record.totalTokens ?? 0,
    meanDecodeTps: record.meanDecodeTps ?? 0,
    peakStreamTps: record.peakStreamTps ?? 0,
    streamCount: record.streamCount ?? record.streams?.length ?? 0,
    raw: record.raw === true,
    bodyAccounting: record.bodyAccounting ?? null,
    bodyRetention: record.bodyRetention ?? null,
    error: record.error ?? null,
  };
}

export class ShowcaseManager {
  constructor(historyPath = HISTORY_PATH, runsDir = RUNS_DIR) {
    /** @type {Map<string, object>} sessionId → live session */
    this.sessions = new Map();
    /** @type {Map<string, string>} sparkId → active sessionId */
    this.activeBySpark = new Map();
    /** @type {Map<string, object[]>} sparkId → archived INDEX records (no bodies) */
    this.historyBySpark = new Map();
    this.historyPath = historyPath;
    this.runStore = new ShowcaseRunStore(runsDir);
    /** @type {ReturnType<typeof setInterval> | null} */
    this._heartbeatTimer = null;
    this._loadHistory();
    this._ensureHeartbeatWatch();
  }

  _loadHistory() {
    try {
      if (!fs.existsSync(this.historyPath)) return;
      const raw = fs.readFileSync(this.historyPath, "utf8");
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return;
      let migrated = 0;
      for (const [sparkId, list] of Object.entries(data)) {
        if (!Array.isArray(list)) continue;
        const cleaned = list
          .filter((r) => r && typeof r === "object" && r.sessionId && r.sparkId)
          .slice(0, HISTORY_LIMIT)
          .map((r) => {
            const record = {
              ...r,
              status: r.status === "running" ? "cancelled" : r.status || "completed",
              fromHistory: true,
            };
            // Legacy index written before bodies moved out: it carries full
            // stream text inline. Migrate it to a run file (or to metadata-only
            // if it is too large) so the index stops growing with manuscripts.
            // Nothing is silently discarded — a run too big to keep is recorded
            // as metadata-only with its original size.
            if (Array.isArray(record.streams) && record.streams.length > 0) {
              migrated++;
              return this._migrateLegacyRecord(record);
            }
            return record;
          });
        if (cleaned.length) this.historyBySpark.set(sparkId, cleaned);
      }
      if (migrated > 0) {
        // Deliberately NOT saved here. This module creates its singleton at
        // import time, so writing during construction would mean importing the
        // file — in a test, a script, or a tool — mutated the real config
        // directory as a side effect. The converted records live in memory and
        // the index is rewritten on the next archive or clear.
        console.warn(
          `[Showcase] ${migrated} legacy history record(s) carry inline bodies; ` +
            `they will move out of the index on the next archive`
        );
      }
    } catch (err) {
      console.warn("[Showcase] failed to load history:", err?.message || err);
    }
  }

  /**
   * Convert one legacy inline-body record to the index shape, IN MEMORY.
   *
   * No disk write: see the note in `_loadHistory`. The bodies stay attached to
   * the in-memory record under `_legacyStreams` so an old run remains viewable
   * and reusable for this process's lifetime; the on-disk index sheds them the
   * next time it is rewritten.
   */
  _migrateLegacyRecord(record) {
    const accounting = measureSessionBody(record.streams);
    const full = { ...record, bodyAccounting: accounting, raw: record.raw === true };
    const indexRecord = historyIndexRecord(full, {
      state: "legacy-inline",
      reason: "loaded-from-pre-split-index",
      retainedBytes: accounting.totalBodyBytes,
      originalBytes: accounting.totalBodyBytes,
    });
    indexRecord._legacyStreams = record.streams;
    return indexRecord;
  }

  _saveHistory() {
    try {
      /** @type {Record<string, object[]>} */
      const out = {};
      for (const [sparkId, list] of this.historyBySpark.entries()) {
        // Strip the in-memory legacy body carrier so the written index never
        // regains the inline prompts this split exists to remove.
        out[sparkId] = list.map(({ _legacyStreams, ...rest }) => rest);
      }
      atomicWrite(this.historyPath, JSON.stringify(out, null, 2), 0o600);
    } catch (err) {
      console.warn("[Showcase] failed to save history:", err?.message || err);
    }
  }

  /**
   * Archive a finished live session (idempotent by sessionId).
   * @param {object} session
   */
  _archiveSession(session) {
    if (!session || session.status === "running") return;
    const record = publicSessionRecord(session, { fromHistory: true });
    const accounting = record.bodyAccounting;

    // The archive decision, made from measured UTF-8 bytes BEFORE anything is
    // serialized. A run whose bodies fit the budget keeps them in its own file;
    // one that does not keeps its metadata and loses its bodies. There is no
    // third option: truncating a prompt and presenting it as the prompt would
    // make every later comparison a lie.
    let bodyRetention;
    if (accounting.totalBodyBytes <= SHOWCASE_LIMITS.maxHistoryBodyBytes) {
      let runFile = null;
      try {
        runFile = this.runStore.write(session.sparkId, session.sessionId, record, atomicWrite);
      } catch (err) {
        console.warn("[Showcase] failed to write run body:", err?.message || err);
      }
      bodyRetention = runFile
        ? { state: "full", runFile, retainedBytes: accounting.totalBodyBytes,
            originalBytes: accounting.totalBodyBytes }
        : { state: "metadata-only", reason: "run-file-write-failed",
            retainedBytes: 0, originalBytes: accounting.totalBodyBytes };
    } else {
      // Nothing is written, and any body file left from a previous archive of
      // this same session id is removed — the record must not claim
      // metadata-only while a stale full body sits on disk beside it.
      this.runStore.remove(session.sparkId, session.sessionId);
      bodyRetention = {
        state: "metadata-only",
        reason: "session-body-limit",
        retainedBytes: 0,
        originalBytes: accounting.totalBodyBytes,
        limitBytes: SHOWCASE_LIMITS.maxHistoryBodyBytes,
      };
    }

    const indexRecord = historyIndexRecord(record, bodyRetention);
    const list = this.historyBySpark.get(session.sparkId) || [];
    const merged = [
      indexRecord,
      ...list.filter((r) => r.sessionId !== indexRecord.sessionId),
    ];
    // Runs evicted past the retention limit take their body files with them.
    // Dropping the index entry alone would orphan the file forever, which is how
    // a "bounded" store grows without bound.
    for (const evicted of merged.slice(HISTORY_LIMIT)) {
      this.runStore.remove(session.sparkId, evicted.sessionId);
    }
    this.historyBySpark.set(session.sparkId, merged.slice(0, HISTORY_LIMIT));
    this._saveHistory();
  }

  getHistory(sparkId) {
    return (this.historyBySpark.get(sparkId) || []).map(historySummary);
  }

  /**
   * Full archived session, or null.
   * @param {string} sparkId
   * @param {string} sessionId
   */
  getHistorySession(sparkId, sessionId) {
    const list = this.historyBySpark.get(sparkId) || [];
    const found = list.find((r) => r.sessionId === sessionId);
    if (!found) return null;

    const retention = found.bodyRetention || { state: "metadata-only" };
    // A pre-split index still holds its bodies in memory for this process.
    if (retention.state === "legacy-inline" && Array.isArray(found._legacyStreams)) {
      return { ...found, streams: found._legacyStreams, fromHistory: true };
    }
    if (retention.state !== "full") {
      return { ...found, streams: [], fromHistory: true };
    }

    const body = this.runStore.read(sparkId, sessionId);
    if (!body) {
      // The index says the bodies were kept; the file says otherwise. Report
      // that honestly rather than returning empty strings that would read as
      // "the run produced nothing".
      return {
        ...found,
        streams: [],
        bodyRetention: {
          ...retention,
          state: "unavailable",
          reason: "run-file-missing-or-unreadable",
        },
        fromHistory: true,
      };
    }
    return { ...found, streams: body.streams, fromHistory: true };
  }

  clearHistory(sparkId) {
    this.historyBySpark.delete(sparkId);
    // Body files go with the index entries. Scoped to this Spark's own
    // directory, so clearing one Spark never touches another's runs.
    this.runStore.removeSpark(sparkId);
    // Drop idle live session shells for this spark
    for (const [sid, session] of this.sessions.entries()) {
      if (session.sparkId === sparkId && session.status !== "running") {
        this.sessions.delete(sid);
      }
    }
    this._saveHistory();
    return { ok: true };
  }

  _ensureHeartbeatWatch() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      this._checkHeartbeats();
    }, HEARTBEAT_CHECK_MS);
    if (typeof this._heartbeatTimer.unref === "function") {
      this._heartbeatTimer.unref();
    }
  }

  _checkHeartbeats() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.status !== "running") continue;
      const last = session._lastTouchAt || session.startedAt;
      if (now - last >= HEARTBEAT_TIMEOUT_MS) {
        this.cancel(session.sparkId, session.sessionId, "Heartbeat timeout");
      }
    }
  }

  getActive(sparkId) {
    const id = this.activeBySpark.get(sparkId);
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.status !== "running") return null;
    return { sessionId: session.sessionId, status: session.status };
  }

  touch(sparkId, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.sparkId !== sparkId) return false;
    session._lastTouchAt = Date.now();
    return true;
  }

  /**
   * @param {{
   *   sparkId: string,
   *   lanIp: string,
   *   port: number,
   *   modelId?: string | null,
   *   maxTokens?: number,
   *   temperature?: number,
   *   thinking?: boolean,
   *   promptType?: string | null,
   *   raw?: boolean,
   *   prompts: string[],
   *   apiKey?: string | null,
   * }} opts
   */
  start(opts) {
    const {
      sparkId,
      lanIp,
      port,
      modelId = null,
      maxTokens: rawMax,
      temperature: rawTemp,
      thinking: rawThinking,
      promptType: rawPromptType,
      raw: rawMode,
      prompts: rawPrompts,
      apiKey = null,
    } = opts;

    if (this.activeBySpark.has(sparkId)) {
      const err = new Error("A showcase is already running for this Spark");
      err.status = 409;
      throw err;
    }
    if (decodeBenchManager.getActive(sparkId)) {
      const err = new Error("A decode benchmark is already running for this Spark");
      err.status = 409;
      throw err;
    }

    // Raw mode is opt-in. Defaulting it off keeps every existing caller — the
    // throughput demo this feature was built for — behaving exactly as before.
    const raw = rawMode === true;

    const prompts = normalizePrompts(rawPrompts, { preserveExact: raw });
    if (!prompts) {
      const err = new Error(
        `prompts must be an array of ${MIN_PROMPTS}–${MAX_PROMPTS} non-empty strings`
      );
      err.status = 400;
      throw err;
    }

    // Size is enforced in UTF-8 bytes, per prompt AND in aggregate. The
    // aggregate limit is the one that matters: a per-prompt ceiling alone would
    // let 32 maximum-size prompts through, which is what the old architecture
    // could not survive. Rejected before any session exists, so a bad request
    // costs nothing.
    const sizeCheck = validatePromptBytes(prompts, SHOWCASE_LIMITS);
    if (!sizeCheck.ok) {
      const err = new Error(sizeCheck.error);
      err.status = 400;
      throw err;
    }

    let maxTokens = Number(rawMax);
    if (!Number.isFinite(maxTokens)) maxTokens = DEFAULT_MAX_TOKENS;
    maxTokens = Math.round(maxTokens);
    if (maxTokens < MIN_MAX_TOKENS || maxTokens > MAX_MAX_TOKENS) {
      const err = new Error(
        `maxTokens must be between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}`
      );
      err.status = 400;
      throw err;
    }

    let temperature = Number(rawTemp);
    if (!Number.isFinite(temperature)) temperature = DEFAULT_TEMPERATURE;
    // Clamp mild float noise; reject out of range
    temperature = Math.round(temperature * 100) / 100;
    if (temperature < MIN_TEMPERATURE || temperature > MAX_TEMPERATURE) {
      const err = new Error(
        `temperature must be between ${MIN_TEMPERATURE} and ${MAX_TEMPERATURE}`
      );
      err.status = 400;
      throw err;
    }

    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      const err = new Error("Invalid LLM port");
      err.status = 400;
      throw err;
    }

    const thinking = rawThinking !== false;
    const promptType =
      typeof rawPromptType === "string" && PROMPT_TYPES.has(rawPromptType)
        ? rawPromptType
        : null;

    const sessionId = randomUUID();
    const abort = new AbortController();
    const cap = contentCap(maxTokens);
    const now = Date.now();

    /** @type {object[]} */
    const streams = prompts.map((prompt, i) => ({
      streamId: String(i),
      label: labelFromPrompt(prompt),
      prompt,
      // Identity of what was submitted vs what will actually be sent. In raw
      // mode these are the same; in non-raw the fill suffix makes them differ,
      // and the record says so rather than leaving it to be inferred.
      promptIdentity: buildPromptIdentity(
        prompt,
        raw ? prompt : withFillToMaxInstruction(prompt)
      ),
      status: "pending",
      /** Answer text (delta.content) */
      content: "",
      /** Reasoning / thinking text */
      reasoning: "",
      contentLength: 0,
      reasoningLength: 0,
      contentCapped: false,
      tokenCount: 0,
      ttftMs: null,
      decodeTps: 0,
      liveTokPerSec: 0,
      peakTokPerSec: 0,
      model: null,
      error: null,
      _t0: null,
      _tFirst: null,
      _tLast: null,
      _abort: null,
    }));

    const session = {
      sessionId,
      sparkId,
      status: "running",
      rev: 0,
      port: p,
      modelId: modelId || null,
      maxTokens,
      temperature,
      thinking,
      promptType,
      raw,
      startedAt: now,
      completedAt: null,
      streams,
      error: null,
      /** Live /metrics generation tok/s strip */
      serverGenerationTps: null,
      serverGenerationTpsMax: null,
      serverGenerationSamples: 0,
      _abort: abort,
      _lastTouchAt: now,
      _contentCap: cap,
      _lanIp: lanIp,
      _apiKey: apiKey != null && String(apiKey).trim() ? String(apiKey).trim() : null,
      _sentContentLengths: /** @type {number[]} */ (prompts.map(() => 0)),
      _sentReasoningLengths: /** @type {number[]} */ (prompts.map(() => 0)),
    };

    this.sessions.set(sessionId, session);
    this.activeBySpark.set(sparkId, sessionId);

    this._runSession(session).catch(() => {
      /* errors recorded on session */
    });

    return { sessionId, status: "running" };
  }

  /**
   * Live snapshot for poll (delta-friendly via `since` rev), or archived history.
   * @param {string} sparkId
   * @param {string} sessionId
   * @param {number | null} [since]
   */
  getSession(sparkId, sessionId, since = null) {
    const session = this.sessions.get(sessionId);
    if (!session || session.sparkId !== sparkId) {
      const hist = this.getHistorySession(sparkId, sessionId);
      if (!hist) return null;
      // Full snapshot shape (no deltas for history)
      return {
        ...hist,
        rev: hist.rev ?? 0,
        streams: (hist.streams || []).map((s) => ({
          ...s,
          contentAppend: "",
          reasoningAppend: "",
          resetContent: false,
        })),
        fromHistory: true,
      };
    }

    this.touch(sparkId, sessionId);

    const sinceRev =
      since != null && Number.isFinite(Number(since))
        ? Math.max(0, Math.floor(Number(since)))
        : null;
    const fullSnapshot = sinceRev == null;

    const streams = session.streams.map((s, i) => {
      const content = s.content || "";
      const reasoning = s.reasoning || "";
      const sentContent = fullSnapshot ? 0 : (session._sentContentLengths[i] ?? 0);
      const sentReasoning = fullSnapshot ? 0 : (session._sentReasoningLengths[i] ?? 0);
      const resetContent =
        !fullSnapshot && (sentContent > content.length || sentReasoning > reasoning.length);

      session._sentContentLengths[i] = content.length;
      session._sentReasoningLengths[i] = reasoning.length;

      /** @type {Record<string, unknown>} */
      const out = {
        streamId: s.streamId,
        label: s.label,
        prompt: s.prompt,
        // Static for the life of the stream, and small. Sent on every poll
        // rather than only in a full snapshot so a client that joined mid-run
        // can still verify what was actually submitted.
        promptIdentity: s.promptIdentity ?? null,
        status: s.status,
        contentLength: s.contentLength,
        reasoningLength: s.reasoningLength,
        resetContent: Boolean(resetContent),
        tokenCount: s.tokenCount,
        ttftMs: s.ttftMs,
        decodeTps: s.decodeTps,
        liveTokPerSec: s.liveTokPerSec,
        peakTokPerSec: s.peakTokPerSec || 0,
        model: s.model,
        error: s.error,
      };

      if (fullSnapshot || resetContent) {
        out.content = content;
        out.reasoning = reasoning;
        out.contentAppend = "";
        out.reasoningAppend = "";
      } else {
        out.contentAppend = content.slice(sentContent);
        out.reasoningAppend = reasoning.slice(sentReasoning);
      }

      return out;
    });

    return {
      sessionId: session.sessionId,
      sparkId: session.sparkId,
      status: session.status,
      rev: session.rev,
      port: session.port,
      modelId: session.modelId,
      maxTokens: session.maxTokens,
      temperature: session.temperature,
      thinking: session.thinking !== false,
      promptType: session.promptType ?? null,
      // The live path is what the UI polls, so raw must be visible here — not
      // only on archived records. Without it the Raw toggle could not be
      // restored when reopening a run that was still in memory.
      raw: session.raw === true,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      serverGenerationTps: session.serverGenerationTps,
      serverGenerationTpsMax: session.serverGenerationTpsMax,
      serverGenerationSamples: session.serverGenerationSamples,
      streams,
      error: session.error,
      fromHistory: false,
    };
  }

  /**
   * @param {string} sparkId
   * @param {string} sessionId
   * @param {string} [reason]
   */
  cancel(sparkId, sessionId, reason = "Cancelled by user") {
    const session = this.sessions.get(sessionId);
    if (!session || session.sparkId !== sparkId) return null;
    if (session.status !== "running") {
      return this.getSession(sparkId, sessionId);
    }

    session._abort.abort();
    for (const s of session.streams) {
      if (!isTerminalStreamStatus(s.status)) {
        s.status = "cancelled";
        if (!s.error) s.error = reason;
        try {
          s._abort?.abort();
        } catch {
          /* ignore */
        }
      }
    }
    session.status = "cancelled";
    session.error = reason;
    session.completedAt = Date.now();
    this._bumpRev(session);
    this.activeBySpark.delete(sparkId);
    this._archiveSession(session);
    return this.getSession(sparkId, sessionId);
  }

  _bumpRev(session) {
    session.rev += 1;
  }

  _updateLiveMetrics(stream, info) {
    const now = performance.now();
    if (info?.tFirst != null) stream._tFirst = info.tFirst;
    if (info?.tLast != null) stream._tLast = info.tLast;
    if (info?.tokenCount != null) stream.tokenCount = info.tokenCount;
    if (info?.model) stream.model = info.model;

    // Floor token count with char estimate — SSE event counts under-report when
    // the backend batches multiple tokens per delta (common on vLLM).
    const chars =
      (stream.content?.length || 0) + (stream.reasoning?.length || 0);
    if (chars > 0) {
      const fromChars = Math.max(1, Math.round(chars / 4));
      stream.tokenCount = Math.max(stream.tokenCount || 0, fromChars);
    }

    if (stream._t0 != null && stream._tFirst != null && stream.ttftMs == null) {
      stream.ttftMs = round2(stream._tFirst - stream._t0);
    }

    // Same window as final decodeTps: first visible token → last visible token
    if (stream._tFirst != null && stream.tokenCount > 0) {
      const tEnd = stream._tLast != null ? stream._tLast : now;
      const elapsedMs = Math.max(0, tEnd - stream._tFirst);
      if (elapsedMs > 0) {
        const decodeTokens = Math.max(0, stream.tokenCount - 1);
        stream.liveTokPerSec = round2((decodeTokens / elapsedMs) * 1000);
        stream.peakTokPerSec = Math.max(
          stream.peakTokPerSec || 0,
          stream.liveTokPerSec
        );
      }
    }
  }

  /**
   * Append to answer and/or reasoning under a shared char cap.
   * @param {object} session
   * @param {object} stream
   * @param {{ answer?: string, reasoning?: string }} parts
   */
  _appendParts(session, stream, parts) {
    if (stream.contentCapped) return;
    const cap = session._contentCap;
    const used = stream.content.length + stream.reasoning.length;
    let room = cap - used;
    if (room <= 0) {
      stream.contentCapped = true;
      return;
    }

    const appendOne = (field, text) => {
      if (!text || room <= 0) return;
      if (text.length <= room) {
        stream[field] += text;
        room -= text.length;
      } else {
        stream[field] += text.slice(0, room);
        room = 0;
        stream.contentCapped = true;
      }
    };

    // Prefer keeping reasoning "alive" then answer
    appendOne("reasoning", parts.reasoning);
    appendOne("content", parts.answer);

    stream.contentLength = stream.content.length;
    stream.reasoningLength = stream.reasoning.length;
  }

  async _runSession(session) {
    const baseUrl = `http://${session._lanIp}:${session.port}`;
    const url = `${baseUrl}/v1/chat/completions`;

    const ratePollAbort = new AbortController();
    const onParentForPoll = () => ratePollAbort.abort();
    if (session._abort.signal.aborted) onParentForPoll();
    else session._abort.signal.addEventListener("abort", onParentForPoll, { once: true });

    const ratePollPromise = pollServerGenerationRates(
      baseUrl,
      ratePollAbort.signal,
      400,
      {
        apiKey: session._apiKey,
        onSample: (info) => {
          if (session.status !== "running") return;
          session.serverGenerationTps = info.median;
          session.serverGenerationTpsMax = info.max;
          session.serverGenerationSamples = info.samples;
          this._bumpRev(session);
        },
      }
    );

    const promises = session.streams.map((stream) => {
      const ctrl = new AbortController();
      stream._abort = ctrl;

      const onParentAbort = () => ctrl.abort();
      if (session._abort.signal.aborted) ctrl.abort();
      else session._abort.signal.addEventListener("abort", onParentAbort, { once: true });

      // Raw mode sends the prompt exactly as supplied and lets the model stop
      // when it is finished. The demo path does the opposite on purpose — fill
      // suffix, min_tokens == max_tokens, ignore_eos — which produces a good
      // wall of moving text and a completion the model was forbidden to end.
      // That is fine for a throughput demo and useless for studying prompts, so
      // the two modes are separated rather than compromised between.
      const body = session.raw
        ? {
            model: session.modelId || undefined,
            messages: [{ role: "user", content: stream.prompt }],
            max_tokens: session.maxTokens, // a ceiling, not a target
            temperature: session.temperature,
            stream: true,
            stream_options: { include_usage: true },
          }
        : {
            model: session.modelId || undefined,
            messages: [
              {
                role: "user",
                content: withFillToMaxInstruction(stream.prompt),
              },
            ],
            max_tokens: session.maxTokens,
            // Prefer full-length generations when the backend supports it (vLLM).
            min_tokens: session.maxTokens,
            ignore_eos: true,
            stop: [],
            temperature: session.temperature,
            stream: true,
            stream_options: { include_usage: true },
          };
      applyThinkingFlags(body, session.modelId, session.thinking !== false);

      stream.status = "streaming";
      stream._t0 = performance.now();
      this._bumpRev(session);

      const timeout = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);

      return runStreamingRequest(url, body, ctrl.signal, {
        collectContent: true,
        retryOnThinking400: true,
        apiKey: session._apiKey,
        onDelta: (info) => {
          if (session.status !== "running") return;
          this._appendParts(session, stream, {
            answer: info?.answer,
            reasoning: info?.reasoning,
          });
          this._updateLiveMetrics(stream, info);
          this._bumpRev(session);
        },
      })
        .then(async (result) => {
          // Non-vLLM OpenAI-compat servers may 400 on min_tokens / ignore_eos.
          // Retry once without those fields rather than failing the whole stream.
          if (
            result.error &&
            /^HTTP 400\b/.test(result.error) &&
            (body.min_tokens != null || body.ignore_eos != null)
          ) {
            result = await runStreamingRequest(
              url,
              stripFillForceFields(body),
              ctrl.signal,
              {
                collectContent: true,
                retryOnThinking400: true,
                apiKey: session._apiKey,
                onDelta: (info) => {
                  if (session.status !== "running") return;
                  this._appendParts(session, stream, {
                    answer: info?.answer,
                    reasoning: info?.reasoning,
                  });
                  this._updateLiveMetrics(stream, info);
                  this._bumpRev(session);
                },
              }
            );
          }

          if (session._abort.signal.aborted && stream.status === "streaming") {
            stream.status = "cancelled";
            stream.error = stream.error || "Cancelled";
          } else if (result.error) {
            stream.status = "error";
            stream.error = result.error;
          } else {
            stream.status = "completed";
            stream.error = null;
          }

          stream.tokenCount = result.completionTokens ?? stream.tokenCount;
          stream.ttftMs =
            result.ttftMs != null && result.ttftMs > 0
              ? result.ttftMs
              : stream.ttftMs;
          stream.decodeTps = result.decodeTps ?? 0;
          stream.liveTokPerSec = stream.decodeTps;
          stream.peakTokPerSec = Math.max(
            stream.peakTokPerSec || 0,
            stream.decodeTps || 0,
            stream.liveTokPerSec || 0
          );
          if (result.model) stream.model = result.model;

          // Prefer live buffers; fill gaps from final collectContent
          if (result.answer && result.answer.length > stream.content.length) {
            stream.content = result.answer;
          }
          if (result.reasoning && result.reasoning.length > stream.reasoning.length) {
            stream.reasoning = result.reasoning;
          }
          // Enforce cap after fill
          const total = stream.content.length + stream.reasoning.length;
          if (total > session._contentCap) {
            const over = total - session._contentCap;
            if (stream.content.length >= over) {
              stream.content = stream.content.slice(0, stream.content.length - over);
            } else {
              const rest = over - stream.content.length;
              stream.content = "";
              stream.reasoning = stream.reasoning.slice(0, Math.max(0, stream.reasoning.length - rest));
            }
            stream.contentCapped = true;
          }
          stream.contentLength = stream.content.length;
          stream.reasoningLength = stream.reasoning.length;

          this._bumpRev(session);
        })
        .finally(() => {
          clearTimeout(timeout);
          session._abort.signal.removeEventListener("abort", onParentAbort);
        });
    });

    try {
      await Promise.all(promises);
    } catch {
      /* per-stream errors recorded */
    } finally {
      ratePollAbort.abort();
      session._abort.signal.removeEventListener("abort", onParentForPoll);
      const rateStats = await ratePollPromise;
      if (rateStats.median != null) session.serverGenerationTps = rateStats.median;
      if (rateStats.max != null) session.serverGenerationTpsMax = rateStats.max;
      session.serverGenerationSamples = rateStats.samples;

      if (session.status === "running") {
        this._finalizeSession(session);
      }
      this.activeBySpark.delete(session.sparkId);
      session.completedAt = session.completedAt ?? Date.now();
      // Archive once when the run settles (cancel may already have archived)
      if (session.status !== "running") {
        this._archiveSession(session);
      }
    }
  }

  _finalizeSession(session) {
    const streams = session.streams;
    const anyOk = streams.some(
      (s) => s.status === "completed" && s.tokenCount > 0
    );
    const allFailed = streams.every(
      (s) => s.status === "error" || (s.status === "completed" && s.tokenCount <= 0)
    );
    const anyCancelled = streams.some((s) => s.status === "cancelled");

    if (session._abort.signal.aborted || anyCancelled) {
      if (session.status === "running") {
        session.status = anyOk ? "completed" : "cancelled";
        if (session.status === "cancelled" && !session.error) {
          session.error = "Cancelled";
        }
      }
    } else if (allFailed && !anyOk) {
      session.status = "error";
      session.error =
        streams.find((s) => s.error)?.error || "All streams failed";
    } else {
      session.status = "completed";
    }
    this._bumpRev(session);
  }
}

/**
 * @param {unknown} raw
 * @returns {string[] | null}
 */
function normalizePrompts(raw, { preserveExact = false } = {}) {
  if (!Array.isArray(raw)) return null;
  if (raw.length < MIN_PROMPTS || raw.length > MAX_PROMPTS) return null;
  /** @type {string[]} */
  const out = [];
  for (const p of raw) {
    if (typeof p !== "string") return null;
    // Emptiness is judged on the trimmed form either way — "did you send
    // anything" is a different question from "what exactly did you send".
    if (p.trim().length < MIN_PROMPT_LEN) return null;
    // Raw mode keeps the caller's exact bytes. Leading indentation, trailing
    // newlines, and CRLF are part of a real prompt: they change the tokens the
    // model sees, and silently trimming them would mean the run measured
    // something the caller never sent. Non-raw keeps the historical trim so
    // existing Showcase behavior is unchanged.
    out.push(preserveExact ? p : p.trim());
  }
  return out;
}

export const showcaseManager = new ShowcaseManager();

export const SHOWCASE_DEFAULTS = {
  defaultMaxTokens: DEFAULT_MAX_TOKENS,
  minMaxTokens: MIN_MAX_TOKENS,
  maxMaxTokens: MAX_MAX_TOKENS,
  defaultTemperature: DEFAULT_TEMPERATURE,
  minTemperature: MIN_TEMPERATURE,
  maxTemperature: MAX_TEMPERATURE,
  minPrompts: MIN_PROMPTS,
  maxPrompts: MAX_PROMPTS,
  heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  historyLimit: HISTORY_LIMIT,
  maxPromptBytes: SHOWCASE_LIMITS.maxPromptBytes,
  maxSessionPromptBytes: SHOWCASE_LIMITS.maxSessionPromptBytes,
  maxHistoryBodyBytes: SHOWCASE_LIMITS.maxHistoryBodyBytes,
};
