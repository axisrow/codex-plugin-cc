import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { waitForBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "app-server-broker.mjs");
const IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS";

function spawnTestBroker({ behavior, idleTimeoutMs = 0 }) {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const sessionDir = makeTempDir("codex-plugin-broker-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const endpoint = `unix:${socketPath}`;
  const pidFile = path.join(sessionDir, "broker.pid");
  installFakeCodex(binDir, behavior);

  const child = spawn(
    process.execPath,
    [BROKER_SCRIPT, "serve", "--endpoint", endpoint, "--cwd", workspace, "--pid-file", pidFile],
    {
      cwd: workspace,
      env: {
        ...buildEnv(binDir),
        [IDLE_TIMEOUT_ENV]: String(idleTimeoutMs)
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  return { child, endpoint, pidFile, socketPath };
}

async function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode != null || child.signalCode != null) {
    return;
  }
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for broker to exit.")), timeoutMs))
  ]);
}

function terminateBroker(child) {
  if (child.exitCode == null && child.signalCode == null) {
    child.kill("SIGTERM");
  }
}

test("broker exits with code 1 and removes runtime files when its app-server child dies", async (t) => {
  const broker = spawnTestBroker({ behavior: "app-server-self-exit" });
  t.after(() => terminateBroker(broker.child));

  assert.equal(await waitForBrokerEndpoint(broker.endpoint), true);
  await waitForExit(broker.child, 3000);

  assert.equal(broker.child.exitCode, 1);
  assert.equal(fs.existsSync(broker.socketPath), false);
  assert.equal(fs.existsSync(broker.pidFile), false);
});

test("broker with a healthy app-server child stays alive", async (t) => {
  const broker = spawnTestBroker({ behavior: "review-ok" });
  t.after(() => terminateBroker(broker.child));

  assert.equal(await waitForBrokerEndpoint(broker.endpoint), true);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(broker.child.exitCode, null);
  assert.equal(broker.child.signalCode, null);
});

// Race A: the app-server child dies (arming the exitPromise self-terminate)
// while a SIGTERM arrives at almost the same instant. Whichever path "wins",
// the broker must still finish cleanup — the socket and pid file must be
// gone after exit. A signal handler that calls process.exit(0) before the
// exitPromise-driven shutdown reaches its unlink step would leave the socket
// behind. Run several iterations because the race is timing-dependent.
test("broker removes runtime files when child exit races with SIGTERM", async (t) => {
  for (let i = 0; i < 10; i += 1) {
    const broker = spawnTestBroker({ behavior: "app-server-self-exit" });
    t.after(() => terminateBroker(broker.child));

    assert.equal(await waitForBrokerEndpoint(broker.endpoint), true);
    // Fire SIGTERM right as the child is about to die (self-exit delay is 50ms).
    // The two termination paths must not trample each other's cleanup.
    setTimeout(() => broker.child.kill("SIGTERM"), 25);
    await waitForExit(broker.child, 3000);

    assert.notEqual(broker.child.exitCode, null);
    assert.equal(fs.existsSync(broker.socketPath), false, `socket leaked on iteration ${i}`);
    assert.equal(fs.existsSync(broker.pidFile), false, `pid file leaked on iteration ${i}`);
  }
});

