import test from "node:test";
import assert from "node:assert/strict";

import { spawnInProcessBroker, FakeAppClient } from "./broker-controller-helpers.mjs";

test("broker exits via idle timer when no client is connected", async () => {
  const { broker, clock } = await spawnInProcessBroker({
    appClient: new FakeAppClient(),
    idleTimeoutMs: 500
  });
  await broker.ready;

  // idle is armed on listen when sockets are empty.
  const armed = await Promise.race([
    broker.idleArmed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50))
  ]);
  assert.equal(armed, true);

  clock.advanceBy(500);
  const result = await broker.stopped;
  assert.equal(result.reason, "idle");
  assert.equal(result.exitCode, 0);
});

test("broker idle timer is cancelled while a client is connected, then fires on disconnect", async () => {
  const { broker, clock, connectClient } = await spawnInProcessBroker({
    appClient: new FakeAppClient(),
    idleTimeoutMs: 500
  });
  await broker.ready;

  const client = await connectClient();
  // Far past the idle window while connected — must NOT stop.
  clock.advanceBy(10_000);
  const winner = await Promise.race([
    broker.stopped.then(() => "stopped"),
    new Promise((resolve) => setTimeout(() => resolve("still-running"), 50))
  ]);
  assert.equal(winner, "still-running");

  client.end();
  await broker.clientClosed;
  // Idle re-arms after the last socket closes; advancing fires it.
  clock.advanceBy(500);
  const result = await broker.stopped;
  assert.equal(result.reason, "idle");
  assert.equal(result.exitCode, 0);
});

test("idle timeout disabled (idleTimeoutMs=0) never arms idle", async () => {
  const { broker } = await spawnInProcessBroker({
    appClient: new FakeAppClient(),
    idleTimeoutMs: 0
  });
  await broker.ready;

  const armed = await Promise.race([
    broker.idleArmed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50))
  ]);
  assert.equal(armed, false);

  broker.signalShutdown("signal");
  const result = await broker.stopped;
  assert.equal(result.exitCode, 0);
});

test("broker/shutdown RPC returns ok and stops cleanly", async () => {
  const { broker, sendRpc } = await spawnInProcessBroker({
    appClient: new FakeAppClient(),
    idleTimeoutMs: 0
  });
  await broker.ready;

  const reply = await sendRpc({ id: 1, method: "broker/shutdown", params: {} });
  assert.deepEqual(reply, { id: 1, result: {} });

  const result = await broker.stopped;
  assert.equal(result.reason, "broker/shutdown");
  assert.equal(result.exitCode, 0);
});

test("broker/shutdown RPC is rejected while a request is in flight", async () => {
  const appClient = new FakeAppClient();
  // turn/start never resolves → the socket stays the active request owner.
  appClient.on("turn/start", () => new Promise(() => {}));
  const { broker, sendRpc } = await spawnInProcessBroker({
    appClient,
    idleTimeoutMs: 0
  });
  await broker.ready;

  // Drive the controller into an active request (fire and forget).
  sendRpc({ id: 1, method: "turn/start", params: {} });
  await broker.clientAccepted;

  const reply = await sendRpc({ id: 2, method: "broker/shutdown", params: {} });
  assert.equal(reply.error?.code, -32001);

  broker.signalShutdown("signal");
  await broker.stopped;
});
