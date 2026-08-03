import test from "node:test";
import assert from "node:assert/strict";

import {
  SPAWNED_INITIALIZE_TIMEOUT_ENV,
  DEFAULT_SPAWNED_INITIALIZE_TIMEOUT_MS,
  MAX_SPAWNED_INITIALIZE_TIMEOUT_MS,
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

// A positive fraction passes a `parsed > 0` check but floors to 0, and request()
// only installs its timer when timeoutMs > 0 — so a sub-millisecond override
// would silently disarm the handshake deadline entirely and let a wedged
// spawned app-server hang forever (the #29/#31 class this deadline exists to
// prevent). Never resolve to 0.
test("resolveSpawnedInitializeTimeoutMs never resolves a positive override to 0", () => {
  for (const rawValue of ["0.5", "0.9", "1e-9", "0.0001"]) {
    const resolved = resolveSpawnedInitializeTimeoutMs({
      [SPAWNED_INITIALIZE_TIMEOUT_ENV]: rawValue
    });
    assert.ok(resolved > 0, `${rawValue} resolved to ${resolved}, which disarms the deadline`);
    // Sub-millisecond is unusable input, so it falls back to the default rather
    // than becoming a 1ms deadline that would fail instantly.
    assert.equal(resolved, DEFAULT_SPAWNED_INITIALIZE_TIMEOUT_MS);
  }
});

// The mirror image of the sub-millisecond case: Node's setTimeout stores its
// delay in a 32-bit signed int, so any value above 2^31-1 is silently reduced
// to 1ms (with a TimeoutOverflowWarning). A user raising the deadline to
// something enormous would get a near-instant handshake failure — the opposite
// of what they asked for. Never resolve above the timer ceiling.
test("resolveSpawnedInitializeTimeoutMs rejects values above Node's timer ceiling", () => {
  for (const rawValue of ["2147483648", "2147483648.7", "9999999999", "1e21"]) {
    const resolved = resolveSpawnedInitializeTimeoutMs({
      [SPAWNED_INITIALIZE_TIMEOUT_ENV]: rawValue
    });
    assert.ok(
      resolved <= MAX_SPAWNED_INITIALIZE_TIMEOUT_MS,
      `${rawValue} resolved to ${resolved}, which setTimeout would reduce to 1ms`
    );
    assert.equal(resolved, DEFAULT_SPAWNED_INITIALIZE_TIMEOUT_MS);
  }

  // The ceiling itself is still a usable value.
  assert.equal(
    resolveSpawnedInitializeTimeoutMs({
      [SPAWNED_INITIALIZE_TIMEOUT_ENV]: String(MAX_SPAWNED_INITIALIZE_TIMEOUT_MS)
    }),
    MAX_SPAWNED_INITIALIZE_TIMEOUT_MS
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
