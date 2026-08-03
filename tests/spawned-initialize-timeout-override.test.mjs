import test from "node:test";
import assert from "node:assert/strict";

import {
  SPAWNED_INITIALIZE_TIMEOUT_ENV,
  DEFAULT_SPAWNED_INITIALIZE_TIMEOUT_MS,
  resolveSpawnedInitializeTimeoutMs
} from "../plugins/codex/scripts/lib/app-server.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

// fork #55: the spawned app-server handshake had a hard 10s deadline with no
// user-facing escape hatch. On a loaded CI runner or a cold start this fails
// with a message the user can neither act on nor tune. The override mirrors
// CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS (app-server-broker.mjs).

test("resolveSpawnedInitializeTimeoutMs honours the env override", () => {
  assert.equal(
    resolveSpawnedInitializeTimeoutMs({ [SPAWNED_INITIALIZE_TIMEOUT_ENV]: "45000" }),
    45000
  );
  assert.equal(
    resolveSpawnedInitializeTimeoutMs({ [SPAWNED_INITIALIZE_TIMEOUT_ENV]: "1500.9" }),
    1500
  );
});

test("resolveSpawnedInitializeTimeoutMs falls back to the default on unusable values", () => {
  for (const rawValue of [undefined, "", "   ", "abc", "-1", "NaN", "Infinity"]) {
    assert.equal(
      resolveSpawnedInitializeTimeoutMs({ [SPAWNED_INITIALIZE_TIMEOUT_ENV]: rawValue }),
      DEFAULT_SPAWNED_INITIALIZE_TIMEOUT_MS,
      `expected default for ${JSON.stringify(rawValue)}`
    );
  }
  assert.equal(resolveSpawnedInitializeTimeoutMs({}), DEFAULT_SPAWNED_INITIALIZE_TIMEOUT_MS);
});

test("explicit spawnedInitializeTimeoutMs wins over the env override", async () => {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeCodex(binDir, "stalled-initialize");
  const env = { ...buildEnv(binDir), [SPAWNED_INITIALIZE_TIMEOUT_ENV]: "60000" };

  const error = await CodexAppServerClient.connect(cwd, {
    disableBroker: true,
    env,
    // The explicit option must still win, otherwise this test would wait 60s.
    spawnedInitializeTimeoutMs: 300
  }).then(
    (client) => {
      client.close().catch(() => {});
      return null;
    },
    (err) => err
  );

  assert.ok(error, "expected the handshake to time out");
  assert.equal(error.code, "EBROKERTIMEOUT");
});

test("the spawned initialize timeout message names the deadline and the override knob", async () => {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeCodex(binDir, "stalled-initialize");
  const env = { ...buildEnv(binDir), [SPAWNED_INITIALIZE_TIMEOUT_ENV]: "300" };

  const error = await CodexAppServerClient.connect(cwd, {
    disableBroker: true,
    env
  }).then(
    (client) => {
      client.close().catch(() => {});
      return null;
    },
    (err) => err
  );

  assert.ok(error, "expected the handshake to time out");
  assert.equal(error.code, "EBROKERTIMEOUT");
  assert.match(error.message, /300ms/, `deadline missing from: ${error.message}`);
  assert.match(
    error.message,
    new RegExp(SPAWNED_INITIALIZE_TIMEOUT_ENV),
    `override knob missing from: ${error.message}`
  );
});
