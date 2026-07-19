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

  const reapAndClean = (signal) => {
    if (workerTeardownStarted) {
      return;
    }
    workerTeardownStarted = true;
    try {
      reapWorkerBrokers(signal != null);
    } catch {
      // Best-effort: never let teardown mask the original failure.
    }
    try {
      rmTrackedTempDirs();
    } catch {}
  };

  // 'exit' is synchronous-only — no awaits, no RPC. We can only unlink files
  // and rm dirs here. Process reaping is left to the async signal handlers
  // (when a signal arrives) and to the parent global-teardown sweep.
  process.on("exit", () => reapAndClean(null));

  process.on("SIGINT", () => {
    reapAndClean("SIGINT");
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    reapAndClean("SIGTERM");
    process.exit(143);
  });
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
 */
async function reapWorkerBrokers(canAwait) {
  for (const cwd of trackedWorkspaces) {
    const session = loadBrokerSession(cwd);
    if (!session) {
      continue;
    }
    const ready = canAwait && session.endpoint
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

async function safeAwait(promise, fallback) {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}
