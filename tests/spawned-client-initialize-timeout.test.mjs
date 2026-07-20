import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

// Reproduces fork #31: when a spawned `codex app-server` accepts stdin but never
// answers `initialize`, SpawnedCodexAppServerClient.initialize() must not hang
// forever. Today request("initialize") has no deadline on the spawned path
// (unlike the broker path's initializeDeadline), so the await hangs. This is the
// RED test — today the connect() promise never settles within the watchdog.
test("spawned client does not hang on initialize when app-server is wedged (#31)", async () => {
  const binDir = makeTempDir();
  const cwd = makeTempDir();
  installFakeCodex(binDir, "stalled-initialize");
  const env = buildEnv(binDir);

  const connectP = CodexAppServerClient.connect(cwd, {
    disableBroker: true, // -> SpawnedCodexAppServerClient (app-server.mjs)
    env, // -> spawn("codex", ["app-server"]) finds the fake on PATH
    // Short handshake budget so the test does not wait on the 10s production
    // default. The wedged spawned child never answers initialize, so the
    // request deadline must fire.
    spawnedInitializeTimeoutMs: 300
  });

  let outcome = "HANG";
  try {
    const winner = await Promise.race([
      connectP.then(
        () => "connected",
        (error) => ({ errored: error.code ?? error.rpcCode ?? error.message })
      ),
      new Promise((resolve) => setTimeout(() => resolve("HANG"), 2000))
    ]);
    outcome = winner;
  } finally {
    // If connect() settled, close the client cleanly. If it hung (outcome HANG),
    // the spawned child is still alive holding the pipe — force the test process
    // to exit so a hang does not stall the suite. The assertion below is what
    // decides pass/fail; this only prevents a wedged child from outliving the test.
    if (outcome === "HANG") {
      process.exit(1);
    }
    const client = await connectP.catch(() => null);
    if (client) {
      await client.close().catch(() => {});
    }
  }

  assert.notEqual(outcome, "HANG", "initialize hung on a wedged spawned app-server (#31)");
  assert.ok(
    outcome && typeof outcome === "object" && outcome.errored === "EBROKERTIMEOUT",
    `expected EBROKERTIMEOUT from wedged spawned app-server, got ${JSON.stringify(outcome)}`
  );
});
