import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  loadBrokerSession,
  sendBrokerShutdown,
  waitForBrokerEndpoint,
  teardownBrokerSession,
  clearBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerTrackedTempDir(dir);
  ensureWorkerExitHandlers();
  return dir;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  // Best-effort registration of broker-spawning workspaces. The companion and
  // the SessionEnd hook both spawn the broker internally via production code,
  // so the test process never sees the broker pid — but given the workspace
  // cwd we can recover it deterministically from broker.json at teardown.
  if (options.cwd && isUnderTestTempRoot(options.cwd)) {
    registerBrokerWorkspace(options.cwd);
  }
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

// ---------------------------------------------------------------------------
// Test-teardown registry + worker exit handlers
//
// `npm test` leaks detached `app-server-broker.mjs` processes (openai/codex-plugin-cc#163):
// spawnBrokerProcess sets detached:true + unref() so the broker survives the
// parent, and node:test does not forward signals to detached grandchildren.
// We cannot capture the broker pid at spawn (it is born in a grandchild
// subprocess), but given the workspace cwd we can read broker.json at teardown
// and recover {endpoint, pid, sessionDir} deterministically. See the plan at
// .claude/plans/506-swirling-bird.md.
// ---------------------------------------------------------------------------

const trackedTempDirs = new Set();
// Plugin-data roots hold broker.json; removing them before the broker is
// reaped would orphan a live process AND make it undiscoverable. So on the
// sync 'exit' path (where we cannot await a reap) we must NOT remove these —
// leave them for the parent global-teardown sweep. On the async signal path
// we reap first, then remove them.
const trackedPluginDataDirs = new Set();
const trackedWorkspaces = new Set();
let workerTeardownStarted = false;
let workerHandlersRegistered = false;

/** Register any temp path (workspace, binDir, plugin-data root) for rm -rf at exit. */
export function registerTrackedTempDir(dir) {
  if (typeof dir === "string" && dir) {
    trackedTempDirs.add(dir);
  }
}

/** Register a workspace cwd that may have spawned a broker, for reaping at exit. */
export function registerBrokerWorkspace(cwd) {
  if (typeof cwd === "string" && cwd) {
    trackedWorkspaces.add(cwd);
  }
}

/** Register the per-worker ephemeral CLAUDE_PLUGIN_DATA root. Removed only AFTER
 *  broker reaping (signal path); on sync exit it is left for the parent sweep. */
export function registerPluginDataDir(dir) {
  if (typeof dir === "string" && dir) {
    trackedPluginDataDirs.add(dir);
  }
}

function isUnderTestTempRoot(target) {
  const tmp = os.tmpdir();
  try {
    const resolvedTarget = fs.realpathSync(target);
    const resolvedTmp = fs.realpathSync(tmp);
    return resolvedTarget.startsWith(resolvedTmp + path.sep);
  } catch {
    return target.startsWith(tmp + path.sep);
  }
}

function ensureWorkerExitHandlers() {
  if (workerHandlersRegistered) {
    return;
  }
  workerHandlersRegistered = true;

  // On a signal (SIGINT/SIGTERM) we CAN await — run the full reap (probe +
  // shutdown + tree-kill + remove files) before exiting. On 'exit' we CANNOT
  // await (sync-only); there we must NOT destroy broker.json / pid-file /
  // sessionDir / the plugin-data root, because a still-running broker would be
  // orphaned AND undiscoverable (the parent sweep keys on broker.json). Leave
  // the broker metadata intact for the parent global-teardown to reap; only
  // remove the non-broker temp dirs (workspace/binDir/home) we created.
  const onSignal = (signal) => {
    if (workerTeardownStarted) {
      return;
    }
    workerTeardownStarted = true;
    Promise.resolve(reapWorkerBrokers(true))
      .catch(() => {})
      .finally(() => {
        try { rmTrackedTempDirs(); } catch {}
        try { rmPluginDataDirs(); } catch {}
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
  };

  process.on("exit", () => {
    if (workerTeardownStarted) {
      return;
    }
    workerTeardownStarted = true;
    // Sync-only: do NOT touch broker metadata here (see onSignal comment).
    try { rmTrackedTempDirs(); } catch {}
  });

  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

/**
 * Reap every broker spawned for a tracked workspace. Mirrors the SessionEnd
 * sequence (session-lifecycle-hook.mjs): loadBrokerSession → sendBrokerShutdown
 * → teardownBrokerSession(killProcess: terminateProcessTree) → clearBrokerSession.
 *
 * Pid-reuse safety: only tree-kill when the endpoint probe confirms the broker
 * is actually live. A stale broker.json may point at a pid the OS recycled into
 * an unrelated process — tree-killing there would kill the wrong thing. Mirrors
 * loadReusableBrokerSessionUnlocked (broker-lifecycle.mjs:193-216).
 *
 * Only called from the async signal path (onSignal) where awaits are safe.
 * The sync 'exit' path deliberately does NOT call this — destroying broker
 * metadata without first terminating the process would orphan a live broker
 * and make it undiscoverable to the parent sweep.
 */
async function reapWorkerBrokers() {
  for (const cwd of trackedWorkspaces) {
    const session = loadBrokerSession(cwd);
    if (!session) {
      continue;
    }
    const ready = session.endpoint
      ? safeAwait(waitForBrokerEndpoint(session.endpoint, 150), false)
      : false;
    const killProcess = ready ? terminateProcessTree : null;
    if (ready && session.endpoint) {
      await safeAwait(sendBrokerShutdown(session.endpoint, 500));
    }
    teardownBrokerSession({
      endpoint: session.endpoint ?? null,
      pidFile: session.pidFile ?? null,
      logFile: session.logFile ?? null,
      sessionDir: session.sessionDir ?? null,
      pid: session.pid ?? null,
      killProcess
    });
    clearBrokerSession(cwd);
  }
}

function rmTrackedTempDirs() {
  for (const dir of trackedTempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
}

// Plugin-data roots are removed ONLY after a reap, because they hold the
// broker.json the parent sweep needs to find any broker this worker missed.
function rmPluginDataDirs() {
  for (const dir of trackedPluginDataDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
}

async function safeAwait(promise, fallback) {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}
