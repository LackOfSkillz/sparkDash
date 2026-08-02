import { spawn as nodeSpawn } from "node:child_process";

/**
 * Launching a local terminal on behalf of a browser click.
 *
 * The dangerous version of this feature accepts a host, a user, or worst of all a command
 * from the page and hands it to a shell. This module exists so that never happens: the only
 * thing the client contributes is a Spark ID, which must already exist in the server-side
 * registry. Everything actually passed to ssh is derived here from configuration the browser
 * cannot reach, validated against a strict pattern, and delivered as an argument array so no
 * shell is involved to interpret it.
 */

/**
 * Aliases configured in the operator's Windows SSH config. Using them keeps key paths and
 * usernames out of this repository entirely — the alias resolves to both on the host.
 */
export const SSH_ALIASES = Object.freeze({
  "gx10-9141": "gx10-head",
  "gx10-5611": "gx10-worker",
});

/**
 * A deliberately narrow shape: an ssh alias, or user@host where host is a hostname or IPv4.
 * Anything carrying whitespace, a shell metacharacter, or a leading dash (which ssh would
 * read as an option) is rejected rather than escaped. Escaping is a losing game; refusing
 * to launch is not.
 */
const SAFE_TARGET = /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isSafeSshTarget(target) {
  return typeof target === "string" && target.length > 0 && target.length <= 128 && SAFE_TARGET.test(target);
}

/**
 * Resolve a registry record to the thing ssh should connect to.
 *
 * Preference order is alias, then the Spark's own configured ssh user/host. The alias is
 * preferred because it carries the operator's key configuration; the configured record is
 * the fallback so a Spark added later still works without editing this file.
 *
 * Returns null when nothing trustworthy can be derived. A null here must become a refusal
 * upstream, never a guess.
 */
export function resolveSshTarget(spark, aliases = SSH_ALIASES) {
  if (!spark || typeof spark !== "object") return null;

  const alias = aliases[spark.id];
  if (isSafeSshTarget(alias)) return alias;

  const host = spark.ssh?.host ?? spark.lanIp ?? null;
  if (!host) return null;
  const user = spark.ssh?.user ?? null;
  const target = user ? `${user}@${host}` : String(host);
  return isSafeSshTarget(target) ? target : null;
}

/**
 * BatchMode=yes makes ssh fail instead of sitting at a password prompt in a window the user
 * may not be looking at. Key auth is configured; if it ever breaks we want a visible error,
 * not a terminal silently waiting for input.
 */
export function sshLaunchArgs(target) {
  if (!isSafeSshTarget(target)) throw new Error("Unsafe SSH target");
  return ["new-tab", "ssh", "-o", "BatchMode=yes", target];
}

export const SSH_LAUNCH_EXE = "wt.exe";

/**
 * Open a terminal for one registry Spark.
 *
 * Async because a missing wt.exe is reported by an asynchronous 'error' event rather than by
 * throwing — returning as soon as spawn() came back would report success for a launch that
 * never happened. This waits for the process to confirm it started.
 *
 * `deps` is injected so tests can assert on what would have been spawned without opening a
 * window. Nothing here reads the HTTP request: the caller must already have resolved the ID
 * against the registry.
 */
export function launchSshShell(spark, deps = {}) {
  const { spawn = nodeSpawn, platform = process.platform } = deps;

  if (platform !== "win32") {
    return Promise.resolve({
      ok: false,
      status: 501,
      error: `SSH launch is implemented for Windows only (this server is running on ${platform})`,
    });
  }

  const target = resolveSshTarget(spark, deps.aliases ?? SSH_ALIASES);
  if (!target) {
    return Promise.resolve({ ok: false, status: 400, error: "No SSH target is configured for this Spark" });
  }

  let child;
  try {
    child = spawn(SSH_LAUNCH_EXE, sshLaunchArgs(target), {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
  } catch (err) {
    return Promise.resolve({ ok: false, status: 500, error: launchFailureMessage(err) });
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.on("error", (err) => done({ ok: false, status: 500, error: launchFailureMessage(err) }));
    child.on("spawn", () => {
      // Detach only once the launch is known to have succeeded, so the terminal outlives
      // this request without the server waiting on it.
      if (typeof child.unref === "function") child.unref();
      done({ ok: true, status: 200, target });
    });
  });
}

/**
 * Turn a spawn failure into something an operator can act on, without leaking a stack trace
 * or a filesystem path into an HTTP response.
 */
export function launchFailureMessage(err) {
  if (err && err.code === "ENOENT") return "Windows Terminal was not found";
  return "Failed to launch the SSH terminal";
}
