import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { withAppServer } from "../plugins/codex/scripts/lib/codex.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { spawnWedgedServer } from "./broker-controller-helpers.mjs";

// Reproduces fork #29 / upstream openai#509: when the shared broker is wedged
// (busy with a long-running request and never reaching the second socket), the
// client must not hang forever on connect + initialize. This is the RED test —
// today there is no deadline on net.createConnection or request("initialize").
test("client does not hang on initialize when broker is wedged (#29/#509)", async () => {
  const wedged = await spawnWedgedServer();
  const cwd = makeTempDir();
  // Short handshake budgets so the test does not wait on the production
  // defaults (2s connect / 5s initialize). The wedged broker connects but
  // never answers initialize, so the initialize deadline must fire.
  const connectP = CodexAppServerClient.connect(cwd, {
    brokerEndpoint: `unix:${wedged.socketPath}`,
    brokerConnectTimeoutMs: 300,
    brokerInitializeTimeoutMs: 500
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
    wedged.cleanup();
  }

  assert.notEqual(outcome, "HANG", "initialize hung on a wedged broker (#29/#509)");
  assert.ok(
    outcome && typeof outcome === "object" && outcome.errored === "EBROKERTIMEOUT",
    `expected EBROKERTIMEOUT from wedged broker, got ${JSON.stringify(outcome)}`
  );
});

// Drives the full withAppServer fallback path: a wedged broker makes the
// broker-client handshake time out, and withAppServer must fall back to a
// direct (spawned) app-server instead of propagating the timeout. Codex review
// of PR #30 caught that the EBROKERTIMEOUT fallback was unreachable because the
// handshake rejects before `client` is assigned, so client.transport is null.
test("withAppServer falls back to a direct app-server when the broker wedges (#29/#509)", async () => {
  const wedged = await spawnWedgedServer();
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  let calls = 0;
  try {
    const result = await Promise.race([
      withAppServer(
        cwd,
        async (client) => {
          calls += 1;
          return { transport: client.transport };
        },
        {
          brokerEndpoint: `unix:${wedged.socketPath}`,
          brokerConnectTimeoutMs: 300,
          brokerInitializeTimeoutMs: 500,
          env
        }
      ),
      new Promise((resolve) => setTimeout(() => resolve({ HANG: true }), 5000))
    ]);

    assert.ok(!result.HANG, "withAppServer hung instead of falling back to direct");
    assert.equal(calls, 1, "the operation must run exactly once via the direct fallback");
    assert.equal(result.transport, "direct", "the operation must run on the direct transport after fallback");
  } finally {
    wedged.cleanup();
  }
});
