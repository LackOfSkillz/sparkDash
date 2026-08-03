/**
 * Per-host SSH coalescing.
 *
 * The collector polls six metric domains plus liveness on overlapping timers, and each one
 * used to open its own SSH connection. With two nodes that peaks at sixteen simultaneous
 * handshakes, while sshd defaults to `MaxStartups 10:30:100` and starts randomly refusing
 * connections past ten. On this deployment the management path is wireless, where a refused
 * or stalled handshake costs a full ConnectTimeout — long enough to look like an offline node.
 *
 * Windows OpenSSH 9.9p2 does not support ControlMaster (verified: "Failed to connect to new
 * control master"), so connection reuse is not available. Instead, calls landing within a
 * short window are concatenated into ONE remote shell invocation, and at most one batch per
 * host is ever in flight. Callers are unchanged — they still await a single command's output.
 *
 * Each command runs in a subshell bracketed by markers carrying its index and exit status, so
 * one failing command cannot corrupt or truncate another's output.
 */

/** Coalescing window. Long enough to catch same-tick pollers, short enough to be invisible. */
export const BATCH_WINDOW_MS = 30;
/** Upper bound on commands per remote invocation, to keep the command line sane. */
export const MAX_BATCH = 12;

/** @type {Map<string, {timer: any, items: Array<object>, running: boolean}>} */
const queues = new Map();

const stats = {
  batches: 0,
  commands: 0,
  coalesced: 0, // commands that rode along in a batch rather than opening their own connection
  batchFailures: 0,
  maxBatchSize: 0,
};

export function sshBatchStats() {
  return { ...stats };
}

export function resetSshBatchStats() {
  stats.batches = 0;
  stats.commands = 0;
  stats.coalesced = 0;
  stats.batchFailures = 0;
  stats.maxBatchSize = 0;
}

/**
 * Marker is random per batch so a command echoing a previous marker cannot forge a boundary.
 * @param {number} n
 */
function makeMarker(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 36).toString(36);
  return `__AETOS_${s.toUpperCase()}__`;
}

/**
 * Wrap each command so its output is delimited and its exit status recoverable.
 * Runs under `set +e` semantics implicitly: a non-zero command must not abort the batch.
 * @param {string[]} cmds
 * @param {string} marker
 */
export function buildBatchScript(cmds, marker) {
  return cmds
    .map((cmd, i) => `echo ${marker} ${i} B; ( ${cmd} ); echo ${marker} ${i} E $?`)
    .join("; ");
}

/**
 * Split batched stdout back into per-command results.
 * A command whose markers are missing is reported as failed rather than silently empty —
 * an absent section means the remote shell died partway, and returning "" would look like
 * a host that answered with nothing.
 * @param {string} stdout
 * @param {string} marker
 * @param {number} count
 * @returns {Array<{ok: boolean, out: string, code: number}>}
 */
export function parseBatchOutput(stdout, marker, count) {
  const results = Array.from({ length: count }, () => ({ ok: false, out: "", code: -1 }));
  const lines = String(stdout).split(/\r?\n/);
  let idx = -1;
  let buf = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith(marker)) {
      const parts = t.split(/\s+/); // marker, index, B|E, [code]
      const i = Number(parts[1]);
      const kind = parts[2];
      if (kind === "B" && Number.isInteger(i)) {
        idx = i;
        buf = [];
        continue;
      }
      if (kind === "E" && Number.isInteger(i)) {
        const code = Number(parts[3]);
        if (i >= 0 && i < count) {
          results[i] = { ok: code === 0, out: buf.join("\n").trim(), code: Number.isFinite(code) ? code : -1 };
        }
        idx = -1;
        buf = [];
        continue;
      }
    }
    if (idx >= 0) buf.push(line);
  }
  return results;
}

/**
 * Queue a command for a host and resolve with just that command's stdout.
 *
 * @param {string} key Stable per-host queue key.
 * @param {string} cmd
 * @param {number} timeoutMs
 * @param {(script: string, timeoutMs: number) => Promise<string>} runner
 *        Executes one remote shell invocation. Injected so tests never spawn ssh.
 * @returns {Promise<string>}
 */
export function enqueueSshCommand(key, cmd, timeoutMs, runner) {
  return new Promise((resolve, reject) => {
    let q = queues.get(key);
    if (!q) {
      q = { timer: null, items: [], running: false };
      queues.set(key, q);
    }
    q.items.push({ cmd, timeoutMs, resolve, reject });
    stats.commands++;
    scheduleFlush(key, runner);
  });
}

function scheduleFlush(key, runner) {
  const q = queues.get(key);
  if (!q || q.timer || q.running) return; // a running batch flushes again on completion
  // Deliberately NOT unref'd. The timer only exists while commands are actually waiting, and
  // unref'ing it lets the event loop drain before the batch fires, abandoning callers with a
  // promise that never settles.
  q.timer = setTimeout(() => {
    q.timer = null;
    void flush(key, runner);
  }, BATCH_WINDOW_MS);
}

async function flush(key, runner) {
  const q = queues.get(key);
  if (!q || q.running || q.items.length === 0) return;

  const batch = q.items.splice(0, MAX_BATCH);
  q.running = true;

  const marker = makeMarker(10);
  const script = buildBatchScript(batch.map((b) => b.cmd), marker);
  // One slow member must not truncate the rest, so the batch inherits the longest timeout
  // plus a small allowance for the extra round trip.
  const timeoutMs = Math.max(...batch.map((b) => b.timeoutMs || 0), 10000) + 2000;

  stats.batches++;
  stats.maxBatchSize = Math.max(stats.maxBatchSize, batch.length);
  if (batch.length > 1) stats.coalesced += batch.length - 1;

  try {
    const stdout = await runner(script, timeoutMs);
    const parsed = parseBatchOutput(stdout, marker, batch.length);
    batch.forEach((item, i) => {
      const r = parsed[i];
      if (!r || r.code === -1) {
        item.reject(new Error("SSH batch returned no section for this command"));
      } else {
        // Non-zero exit is handed back as output, matching the previous single-command
        // behaviour where collectors tolerate empty/partial stdout and parse defensively.
        item.resolve(r.out);
      }
    });
  } catch (err) {
    stats.batchFailures++;
    for (const item of batch) item.reject(err);
  } finally {
    q.running = false;
    if (q.items.length > 0) scheduleFlush(key, runner);
    else if (!q.timer) queues.delete(key);
  }
}

/** Test seam: drop all queued work without running it. */
export function _resetSshQueues() {
  for (const q of queues.values()) if (q.timer) clearTimeout(q.timer);
  queues.clear();
}
