import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");
const IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS";
const IPC_ENV = "CODEX_COMPANION_BROKER_IPC";

// The ONE real-process test: argv wiring, real signal delivery, real
// process.exit code propagation, file cleanup, and the app-server-self-exit
// path through the CLI. IPC `ready`/`stopped` messages are the causal readiness
// barrier that replaces socket probing (the flakiness root cause). fork() with
// detached:false keeps the child in our process group for fallback teardown.

function forkBroker({ argv, env, cwd }) {
  return fork(BROKER_SCRIPT, argv, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: false
  });
}

function onceMessage(child, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for IPC ${type}.`)), timeoutMs);
    const onMessage = (msg) => {
      if (msg?.type === type) {
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve(msg);
      }
    };
    child.on("message", onMessage);
  });
}

function captureOutput(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    stdout: () => stdout,
    stderr: () => stderr
  };
}

test("broker CLI: IPC-ready, SIGTERM teardown, exit code, file cleanup", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const sessionDir = makeTempDir("broker-smoke-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const pidFile = path.join(sessionDir, "broker.pid");
  installFakeCodex(binDir, "review-ok");

  const child = forkBroker({
    argv: ["serve", "--endpoint", `unix:${socketPath}`, "--cwd", workspace, "--pid-file", pidFile],
    env: {
      ...buildEnv(binDir),
      [IDLE_TIMEOUT_ENV]: "0",
      [IPC_ENV]: "1"
    },
    cwd: workspace
  });
  const out = captureOutput(child);
  t.after(() => {
    try {
      if (child.exitCode == null && child.signalCode == null) {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {}
  }, { always: true });

  await onceMessage(child, "ready");

  child.kill("SIGTERM");
  const stopped = await onceMessage(child, "stopped");
  assert.equal(stopped.reason, "signal");
  assert.equal(stopped.exitCode, 0);

  await once(child, "exit");
  assert.equal(child.exitCode, 0);
  assert.equal(fs.existsSync(socketPath), false, `socket not cleaned.\nstdout:\n${out.stdout()}\nstderr:\n${out.stderr()}`);
  assert.equal(fs.existsSync(pidFile), false, `pid file not cleaned.\nstdout:\n${out.stdout()}\nstderr:\n${out.stderr()}`);
});

test("broker CLI: exits with code 1 when app-server child dies (ACK-based)", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const sessionDir = makeTempDir("broker-smoke-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const pidFile = path.join(sessionDir, "broker.pid");
  installFakeCodex(binDir, "app-server-self-exit");

  const child = forkBroker({
    argv: ["serve", "--endpoint", `unix:${socketPath}`, "--cwd", workspace, "--pid-file", pidFile],
    env: {
      ...buildEnv(binDir),
      [IDLE_TIMEOUT_ENV]: "0",
      [IPC_ENV]: "1"
    },
    cwd: workspace
  });
  const out = captureOutput(child);
  t.after(() => {
    try {
      if (child.exitCode == null && child.signalCode == null) {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {}
  }, { always: true });

  await onceMessage(child, "ready");
  // The fake exits on its `initialized` notification, so by the time we're
  // ready the child has died (or is about to) — stopped should resolve app-server-exit.
  const stopped = await onceMessage(child, "stopped", 10000);
  assert.equal(stopped.reason, "app-server-exit");
  assert.equal(stopped.exitCode, 1);

  await once(child, "exit");
  assert.equal(child.exitCode, 1, `unexpected exit.\nstdout:\n${out.stdout()}\nstderr:\n${out.stderr()}`);
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(fs.existsSync(pidFile), false);
});
