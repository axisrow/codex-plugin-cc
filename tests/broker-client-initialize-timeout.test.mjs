import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
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
