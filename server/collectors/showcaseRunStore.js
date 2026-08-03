/**
 * Per-run body storage for Showcase.
 *
 * The history index used to carry every prompt and every output for the last 20
 * runs of every Spark, in one JSON file rewritten in full on each archive. That
 * is fine at 4,000-character prompts and catastrophic at real ones: the index
 * grows without bound, every archive re-serializes all of it, and past Node's
 * maximum string length the write throws and persistence silently stops.
 *
 * So bodies move out. The index keeps summaries, hashes, and byte counts — it
 * stays small and cheap to rewrite. A run's full body lives in its own file, and
 * only when it fits the archive budget.
 *
 * A body exists in AT MOST ONE persisted place. The index never duplicates it.
 */

import fs from "fs";
import path from "path";

/**
 * Reduce an id to a filesystem-safe token.
 *
 * Whitelist, not blacklist. Spark ids come from configuration and session ids
 * are generated UUIDs, but this store writes to disk from those values, and a
 * path component derived from a name is exactly where traversal gets in. `..`
 * cannot survive this, because `.` is not in the allowed set.
 */
export function safeIdSegment(id) {
  const cleaned = String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 128) : "_";
}

export class ShowcaseRunStore {
  /** @param {string} rootDir Directory holding all per-run body files. */
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  /** Absolute path for one run's body file. Derived only from sanitized ids. */
  runFilePath(sparkId, sessionId) {
    return path.join(this.rootDir, safeIdSegment(sparkId), `${safeIdSegment(sessionId)}.json`);
  }

  /** Index-relative reference stored in the history index. Never absolute. */
  runFileRef(sparkId, sessionId) {
    return `${safeIdSegment(sparkId)}/${safeIdSegment(sessionId)}.json`;
  }

  /**
   * Write one run body. Overwrites an existing file for the same session, so
   * re-archiving the same session id is idempotent rather than accumulating.
   */
  write(sparkId, sessionId, record, atomicWrite) {
    const file = this.runFilePath(sparkId, sessionId);
    atomicWrite(file, JSON.stringify(record, null, 2), 0o600);
    return this.runFileRef(sparkId, sessionId);
  }

  /**
   * Read one run body.
   *
   * Returns null for missing, unreadable, or malformed files. A body file that
   * has been deleted or corrupted must degrade to "bodies unavailable" — it must
   * never take down the history route or the index alongside it.
   */
  read(sparkId, sessionId) {
    const file = this.runFilePath(sparkId, sessionId);
    try {
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.streams)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Delete one run's body file. Already-missing is success, not an error. */
  remove(sparkId, sessionId) {
    const file = this.runFilePath(sparkId, sessionId);
    try {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete every body file for one Spark, then its directory if empty.
   * Scoped to that Spark's own directory — clearing one Spark's history must
   * never touch another's.
   */
  removeSpark(sparkId) {
    const dir = path.join(this.rootDir, safeIdSegment(sparkId));
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Body files currently on disk for one Spark. Diagnostics and tests. */
  list(sparkId) {
    const dir = path.join(this.rootDir, safeIdSegment(sparkId));
    try {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
  }
}
