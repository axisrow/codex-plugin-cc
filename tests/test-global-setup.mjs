// Global test setup/teardown for the parent test-runner process.
//
// node:test defaults to --test-isolation=process, so each *.test.mjs runs in
// its own worker child. Workers spawn detached app-server-broker.mjs processes
// (via production spawnBrokerProcess) and register their own process.exit /
// SIGINT handlers in tests/helpers.mjs to reap what they spawned. This module
// is the catch-all that runs ONCE in the parent after all workers exit: it
// sweeps broker.json files left on disk for any broker a worker missed
// (crashed worker, wedged broker, abnormal exit that beat the worker handler)
// and removes the ephemeral plugin-data roots.
//
// See .claude/plans/506-swirling-bird.md and openai/codex-plugin-cc#163.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  sendBrokerShutdown,
  waitForBrokerEndpoint,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const TEST_DATA_PREFIX = "codex-plugin-test-data-";

// node:test's global teardown contract: the runner looks for a NAMED
// `globalTeardown` export on the module — the function RETURNED by globalSetup
// is NOT called (verified empirically against Node 25.9.0). Both must be
// named exports; returning teardown from setup is a no-op.
export async function globalSetup() {
  registerParentHandlers();
}

export async function globalTeardown() {
  await sweepOrphanedBrokers();
  rmTestPluginDataDirs();
}

function registerParentHandlers() {
  // On abnormal exit (SIGINT/SIGTERM), run the best-effort sync-ish sweep before
  // exiting. Workers also reap on their own SIGINT, but a worker may die before
  // its handler runs; this is the parent's safety net.
  const onSignal = (signal) => {
    sweepOrphanedBrokers().catch(() => {}).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

/**
 * Sweep every ephemeral plugin-data root under os.tmpdir() for broker.json
 * files and reap the brokers they point at. Mirrors the SessionEnd sequence
 * (session-lifecycle-hook.mjs) and loadReusableBrokerSessionUnlocked's
 * pid-reuse safety: only tree-kill when the endpoint probe confirms the
 * broker is live (broker-lifecycle.mjs:193-216).
 */
async function sweepOrphanedBrokers() {
  for (const pluginDataDir of listTestPluginDataDirs()) {
    const stateRoot = path.join(pluginDataDir, "state");
    let workspaces;
    try {
      workspaces = fs.readdirSync(stateRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(stateRoot, entry.name));
    } catch {
      continue;
    }
    for (const stateDir of workspaces) {
      await reapStateDirBroker(stateDir);
    }
  }
}

async function reapStateDirBroker(stateDir) {
  const brokerFile = path.join(stateDir, "broker.json");
  let session;
  try {
    session = JSON.parse(fs.readFileSync(brokerFile, "utf8"));
  } catch {
    return; // no broker.json here — nothing to reap
  }

  const endpoint = session.endpoint ?? null;
  const ready = endpoint ? await safeAwait(waitForBrokerEndpoint(endpoint, 150), false) : false;
  // Only trust the recorded pid for tree-kill when the endpoint probe confirms
  // the broker is live — a stale session may point at a recycled pid.
  const killProcess = ready ? terminateProcessTree : null;
  if (ready && endpoint) {
    await safeAwait(sendBrokerShutdown(endpoint, 500));
  }
  teardownBrokerSession({
    endpoint,
    pidFile: session.pidFile ?? null,
    logFile: session.logFile ?? null,
    sessionDir: session.sessionDir ?? null,
    pid: session.pid ?? null,
    killProcess
  });
  try {
    fs.unlinkSync(brokerFile);
  } catch {}
}

function rmTestPluginDataDirs() {
  for (const dir of listTestPluginDataDirs()) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
}

function listTestPluginDataDirs() {
  let entries;
  try {
    entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEST_DATA_PREFIX))
    .map((entry) => path.join(os.tmpdir(), entry.name));
}

async function safeAwait(promise, fallback) {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}
