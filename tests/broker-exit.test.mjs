import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { spawnInProcessBroker, FakeAppClient } from "./broker-controller-helpers.mjs";

test("broker stops with exitCode 1 and unlinks runtime files when its app-server child exits", async () => {
  const { broker, appClient, socketPath, pidFile } = await spawnInProcessBroker({
    appClient: new FakeAppClient()
  });
  await broker.ready;

  // Causal child-death: replaces the fake-codex fixture's boot-relative timer.
  appClient.crash();

  const result = await broker.stopped;
  assert.equal(result.reason, "app-server-exit");
  assert.equal(result.exitCode, 1);
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(fs.existsSync(pidFile), false);
});

test("broker stays up when its app-server child is healthy", async () => {
  const { broker, appClient, socketPath, pidFile } = await spawnInProcessBroker({
    appClient: new FakeAppClient()
  });
  await broker.ready;

  // Deterministic "still running" check: race stopped against a short wall-clock.
  // No sleep-and-sample of exitCode — if nothing resolves stopped, the broker is up.
  const winner = await Promise.race([
    broker.stopped.then(() => "stopped"),
    new Promise((resolve) => setTimeout(() => resolve("still-running"), 50))
  ]);
  assert.equal(winner, "still-running");
  assert.equal(fs.existsSync(socketPath), true);
  assert.equal(fs.existsSync(pidFile), true);

  // Tear down cleanly.
  appClient.crash();
  await broker.stopped;
});
