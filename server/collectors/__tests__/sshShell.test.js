import { test } from "node:test";
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import {
  SSH_ALIASES,
  SSH_LAUNCH_EXE,
  isSafeSshTarget,
  launchFailureMessage,
  launchSshShell,
  resolveSshTarget,
  sshLaunchArgs,
} from "../../sshShell.js";

/**
 * What these tests defend is a single property: a browser click can open a terminal, but a
 * browser cannot decide what that terminal runs. Everything ssh receives is derived from the
 * server-side registry and validated here.
 */

const HEAD = {
  id: "gx10-9141",
  name: "gx10-9141",
  lanIp: "192.168.1.200",
  ssh: { host: "192.168.1.200", user: "gary", auth: "key" },
};
const WORKER = {
  id: "gx10-5611",
  name: "gx10-5611",
  lanIp: "192.168.1.201",
  ssh: { host: "192.168.1.201", user: "gary", auth: "key" },
};

/** A stand-in for ChildProcess that reports success on the next tick, like a real spawn. */
function fakeSpawn(calls, outcome = "spawn") {
  return (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.unref = () => {
      child.unrefCalled = true;
    };
    queueMicrotask(() => {
      if (outcome === "spawn") child.emit("spawn");
      else child.emit("error", Object.assign(new Error("spawn wt.exe ENOENT"), { code: "ENOENT" }));
    });
    return child;
  };
}

test("valid head ID resolves to the approved SSH target", () => {
  assert.equal(resolveSshTarget(HEAD), "gx10-head");
  assert.equal(SSH_ALIASES["gx10-9141"], "gx10-head");
});

test("valid worker ID resolves to the approved SSH target", () => {
  assert.equal(resolveSshTarget(WORKER), "gx10-worker");
  assert.equal(SSH_ALIASES["gx10-5611"], "gx10-worker");
});

test("a Spark with no alias falls back to its own configured user@host", () => {
  const other = { id: "gx10-other", ssh: { host: "192.168.1.202", user: "gary" } };
  assert.equal(resolveSshTarget(other), "gary@192.168.1.202");
});

test("a Spark with nothing configured resolves to null rather than a guess", () => {
  assert.equal(resolveSshTarget({ id: "nope" }), null);
  assert.equal(resolveSshTarget(null), null);
  assert.equal(resolveSshTarget(undefined), null);
});

test("unknown Spark ID never reaches a launch — resolution is registry-driven", async () => {
  // The route 404s before calling launchSshShell; this pins the layer below it, where an
  // object that is not a registry record must not produce a target.
  const calls = [];
  const res = await launchSshShell({ id: "does-not-exist" }, { spawn: fakeSpawn(calls), platform: "win32" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0, "nothing may be spawned for an unresolvable Spark");
});

test("non-Windows platform returns unsupported and spawns nothing", async () => {
  for (const platform of ["linux", "darwin"]) {
    const calls = [];
    const res = await launchSshShell(HEAD, { spawn: fakeSpawn(calls), platform });
    assert.equal(res.ok, false);
    assert.equal(res.status, 501);
    assert.match(res.error, /Windows only/);
    assert.equal(calls.length, 0, "no fallback shell may run on an unsupported platform");
  }
});

test("wt.exe spawn receives an argument array, never a shell string", async () => {
  const calls = [];
  const res = await launchSshShell(HEAD, { spawn: fakeSpawn(calls), platform: "win32" });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);

  const [exe, args, opts] = calls[0];
  assert.equal(exe, SSH_LAUNCH_EXE);
  assert.ok(Array.isArray(args), "args must be an array so no shell parses them");
  assert.deepEqual(args, ["new-tab", "ssh", "-o", "BatchMode=yes", "gx10-head"]);
  // shell:true would reintroduce exactly the injection surface this module exists to remove.
  assert.notEqual(opts.shell, true);
  assert.equal(opts.detached, true);
  assert.equal(opts.stdio, "ignore");
});

test("no arbitrary client command reaches the spawn call", async () => {
  // A hostile body shaped like a registry record: every field a client might try to smuggle.
  const hostile = {
    ...HEAD,
    command: "calc.exe",
    args: ["--evil"],
    ssh: { host: "192.168.1.200; calc.exe", user: "gary && whoami" },
  };
  const calls = [];
  await launchSshShell(hostile, { spawn: fakeSpawn(calls), platform: "win32" });

  const [, args] = calls[0];
  // The alias wins over the poisoned ssh block, and nothing extra is appended.
  assert.deepEqual(args, ["new-tab", "ssh", "-o", "BatchMode=yes", "gx10-head"]);
  const flat = args.join(" ");
  for (const bad of ["calc.exe", "--evil", ";", "&&", "whoami"]) {
    assert.ok(!flat.includes(bad), `"${bad}" must never reach the argument array`);
  }
});

test("a poisoned target with no alias is refused, not escaped", async () => {
  const poisoned = { id: "unaliased", ssh: { host: "1.2.3.4; calc.exe", user: "gary" } };
  const calls = [];
  const res = await launchSshShell(poisoned, { spawn: fakeSpawn(calls), platform: "win32" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("target validation rejects shell metacharacters, spaces and option-like values", () => {
  for (const ok of ["gx10-head", "gary@192.168.1.200", "host.example.com"]) {
    assert.ok(isSafeSshTarget(ok), `${ok} should be accepted`);
  }
  for (const bad of [
    "gx10-head; calc.exe",
    "gx10 head",
    "-oProxyCommand=calc.exe",
    "host|calc",
    "host&&calc",
    "host$(calc)",
    "host`calc`",
    "",
    null,
    undefined,
    "a".repeat(129),
  ]) {
    assert.ok(!isSafeSshTarget(bad), `${String(bad)} should be rejected`);
  }
});

test("sshLaunchArgs refuses to build args for an unsafe target", () => {
  assert.throws(() => sshLaunchArgs("host; calc.exe"), /Unsafe SSH target/);
  assert.throws(() => sshLaunchArgs("-oProxyCommand=calc"), /Unsafe SSH target/);
});

test("launch failure returns a safe error naming the missing terminal", async () => {
  const calls = [];
  const res = await launchSshShell(HEAD, { spawn: fakeSpawn(calls, "error"), platform: "win32" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
  assert.equal(res.error, "Windows Terminal was not found");
});

test("a spawn that throws synchronously is reported, not propagated", async () => {
  const res = await launchSshShell(HEAD, {
    platform: "win32",
    spawn: () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
  assert.equal(res.error, "Failed to launch the SSH terminal");
});

test("failure messages carry no stack trace or filesystem path", () => {
  const withPath = Object.assign(new Error("spawn C:\\Users\\someone\\.ssh\\id_ed25519 failed"), {
    code: "EPERM",
    stack: "Error: at C:\\Users\\someone\\secret.js:1:1",
  });
  const msg = launchFailureMessage(withPath);
  assert.equal(msg, "Failed to launch the SSH terminal");
  assert.ok(!/Users|\.ssh|id_ed25519|stack/i.test(msg));
});

test("credentials and key material are never returned by a successful launch", async () => {
  const withSecrets = {
    ...HEAD,
    password: "hunter2",
    ssh: { ...HEAD.ssh, password: "hunter2", privateKeyPath: "C:\\Users\\someone\\.ssh\\id_ed25519" },
  };
  const calls = [];
  const res = await launchSshShell(withSecrets, { spawn: fakeSpawn(calls), platform: "win32" });

  const serialized = JSON.stringify(res) + JSON.stringify(calls);
  for (const secret of ["hunter2", "id_ed25519", ".ssh", "privateKeyPath", "password"]) {
    assert.ok(!serialized.includes(secret), `"${secret}" must not appear in the result or the spawn args`);
  }
  assert.deepEqual(Object.keys(res).sort(), ["ok", "status", "target"]);
});

test("the process is detached and unref'd so the terminal outlives the request", async () => {
  const calls = [];
  const children = [];
  const spawn = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.unref = () => {
      child.unrefCalled = true;
    };
    children.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  await launchSshShell(HEAD, { spawn, platform: "win32" });
  assert.equal(children[0].unrefCalled, true);
});
