import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { withBrokerLock } from "../plugins/codex/scripts/lib/broker-lock.mjs";
import { loadBrokerSession, sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_LIFECYCLE = path.join(ROOT, "plugins", "codex", "scripts", "lib", "broker-lifecycle.mjs");

function startEnsureProcess(cwd, env) {
  const source = [
    `import { ensureBrokerSession } from ${JSON.stringify(BROKER_LIFECYCLE)};`,
    "const session = await ensureBrokerSession(process.cwd());",
    "console.log(JSON.stringify(session));"
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("concurrent startup creates and records only one shared broker", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = buildEnv(binDir);

  const [first, second] = await Promise.all([
    startEnsureProcess(repo, env),
    startEnsureProcess(repo, env)
  ]);

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(first.stdout).endpoint, JSON.parse(second.stdout).endpoint);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).appServerStarts, 1);

  const broker = loadBrokerSession(repo);
  await sendBrokerShutdown(broker.endpoint);
});

test("broker lock recovers immediately when its owner process is gone", async () => {
  const repo = makeTempDir();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "broker.lock"), "2147483647:0:abandoned", "utf8");

  const result = await withBrokerLock(repo, { lockTimeoutMs: 100 }, async () => "acquired");

  assert.equal(result, "acquired");
  assert.equal(fs.existsSync(path.join(stateDir, "broker.lock")), false);
});
