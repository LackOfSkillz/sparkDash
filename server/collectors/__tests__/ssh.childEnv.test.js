import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildSshChildEnv } from "../ssh.js";

// The child env handed to ssh/sshpass is a whitelist, not a copy of process.env.
// These tests pin both halves of that contract: the platform keys ssh needs are
// present, and nothing else from the parent leaks through.

test("buildSshChildEnv: Windows parent -> HOME falls back to USERPROFILE", () => {
  const env = buildSshChildEnv({
    PATH: "C:\\Windows\\System32",
    USERPROFILE: "C:\\Users\\gary",
    ProgramData: "C:\\ProgramData",
  });

  // Windows OpenSSH resolves ~ from USERPROFILE; HOME must not fall through to "/root",
  // or ~/.ssh/config and the user's keys are never found and key auth cannot work.
  assert.equal(env.HOME, "C:\\Users\\gary");
  assert.equal(env.USERPROFILE, "C:\\Users\\gary");
  // Without ProgramData, ssh.exe exits 255 with empty stdout AND stderr.
  assert.equal(env.ProgramData, "C:\\ProgramData");
  assert.equal(env.PATH, "C:\\Windows\\System32");
});

test("buildSshChildEnv: explicit HOME wins over USERPROFILE", () => {
  const env = buildSshChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/gary",
    USERPROFILE: "C:\\Users\\gary",
  });
  assert.equal(env.HOME, "/home/gary");
  // USERPROFILE is still forwarded when present; it just does not override HOME.
  assert.equal(env.USERPROFILE, "C:\\Users\\gary");
});

test("buildSshChildEnv: POSIX parent is unchanged by the Windows support", () => {
  const env = buildSshChildEnv({
    PATH: "/usr/bin:/bin",
    HOME: "/home/gary",
    USER: "gary",
    LOGNAME: "gary",
    TERM: "xterm-256color",
    SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock",
  });

  assert.equal(env.HOME, "/home/gary");
  assert.equal(env.USER, "gary");
  assert.equal(env.LOGNAME, "gary");
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.SSH_AUTH_SOCK, "/run/user/1000/ssh-agent.sock");
  assert.equal(env.PATH, "/usr/bin:/bin");
  // Keys absent from the parent must not be invented.
  assert.ok(!("ProgramData" in env), "ProgramData must not appear for a POSIX parent");
  assert.ok(!("USERPROFILE" in env), "USERPROFILE must not appear for a POSIX parent");
});

test("buildSshChildEnv: empty parent falls back to POSIX defaults", () => {
  const env = buildSshChildEnv({});
  assert.equal(env.PATH, "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  assert.equal(env.HOME, "/root");
  assert.equal(env.TERM, "xterm");
  assert.ok(!("SSH_AUTH_SOCK" in env));
  assert.ok(!("ProgramData" in env));
  assert.ok(!("USERPROFILE" in env));
});

test("buildSshChildEnv: SSH_AUTH_SOCK is forwarded only when set", () => {
  assert.ok(!("SSH_AUTH_SOCK" in buildSshChildEnv({ PATH: "/usr/bin" })));
  assert.equal(
    buildSshChildEnv({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/tmp/agent.sock" }).SSH_AUTH_SOCK,
    "/tmp/agent.sock"
  );
});

test("buildSshChildEnv: secrets in the parent never reach the child", () => {
  const env = buildSshChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/gary",
    GITHUB_TOKEN: "ghp_should_not_leak",
    AWS_SECRET_ACCESS_KEY: "aws_should_not_leak",
    OPENAI_API_KEY: "sk_should_not_leak",
    HF_TOKEN: "hf_should_not_leak",
    SSHPASS: "should_not_be_inherited",
  });

  for (const key of [
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "OPENAI_API_KEY",
    "HF_TOKEN",
    "SSHPASS",
  ]) {
    assert.ok(!(key in env), `${key} must not be copied into the ssh child env`);
  }

  // Belt and braces: no value anywhere in the child env carries a leaked secret.
  const values = Object.values(env).filter(Boolean).join("\u0000");
  assert.ok(!values.includes("should_not_leak"));
  assert.ok(!values.includes("should_not_be_inherited"));
});

test("buildSshChildEnv: returns only the expected key set", () => {
  const windows = new Set(
    Object.keys(
      buildSshChildEnv({
        PATH: "C:\\Windows\\System32",
        USERPROFILE: "C:\\Users\\gary",
        ProgramData: "C:\\ProgramData",
        SSH_AUTH_SOCK: "/tmp/a.sock",
        USER: "gary",
        LOGNAME: "gary",
      })
    )
  );
  const allowed = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TERM",
    "USERPROFILE",
    "ProgramData",
    "SSH_AUTH_SOCK",
  ]);
  for (const k of windows) {
    assert.ok(allowed.has(k), `unexpected key in ssh child env: ${k}`);
  }
});
