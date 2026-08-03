import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { withAppServer } from "../plugins/codex/scripts/lib/codex.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, scaleTimeout } from "./helpers.mjs";
import { spawnBusyBroker, spawnWedgedServer } from "./broker-controller-helpers.mjs";

/**
 * Race `promise` against a watchdog that resolves to `hangValue`.
 *
 * The watchdog timer is cleared once the race settles. A bare
 * `setTimeout` in a Promise.race keeps the event loop alive for the full
 * budget even when the real promise won, which held the test process open
 * long after the assertions passed.
 */
async function raceHang(promise, hangValue, budgetMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(hangValue), scaleTimeout(budgetMs));
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
  //
  // These two stay unscaled on purpose: they are the deadlines under test, and
  // the assertion below is that the client honors them. Only the HANG watchdog
  // racing them is scaled, since that one budgets real connect work.
  const connectP = CodexAppServerClient.connect(cwd, {
    brokerEndpoint: `unix:${wedged.socketPath}`,
    brokerConnectTimeoutMs: 300,
    brokerInitializeTimeoutMs: 500
  });

  let outcome = "HANG";
  try {
    outcome = await raceHang(
      connectP.then(
        () => "connected",
        (error) => ({ errored: error.code ?? error.rpcCode ?? error.message })
      ),
      "HANG",
      2000
    );
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
    const result = await raceHang(
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
      { HANG: true },
      5000
    );

    assert.ok(!result.HANG, "withAppServer hung instead of falling back to direct");
    assert.equal(calls, 1, "the operation must run exactly once via the direct fallback");
    assert.equal(result.transport, "direct", "the operation must run on the direct transport after fallback");
  } finally {
    wedged.cleanup();
  }
});

// Drives the post-handshake busy fallback: the broker accepts initialize, then
// returns BROKER_BUSY_RPC_CODE (-32001) for the operation's first request.
// withAppServer must fall back to a direct app-server. Codex review of PR #32
// caught that collapsing the OR-chain onto error.transport broke this path
// (transport is tagged only on handshake failure, not on post-handshake busy).
test("withAppServer falls back to a direct app-server on broker/busy after a successful handshake (#32)", async () => {
  const busy = await spawnBusyBroker();
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const env = buildEnv(binDir);

  let calls = 0;
  try {
    const result = await raceHang(
      withAppServer(
        cwd,
        async (client) => {
          calls += 1;
          // Any real RPC: on the broker client this hits broker/busy (-32001)
          // and must trigger the direct fallback; on the direct client it
          // resolves normally via the fake-codex app-server.
          await client.request("account/read", {});
          return { transport: client.transport };
        },
        {
          brokerEndpoint: `unix:${busy.socketPath}`,
          env
        }
      ),
      { HANG: true },
      5000
    );

    assert.ok(!result.HANG, "withAppServer hung instead of falling back to direct on broker/busy");
    // The broker attempt hits -32001, withAppServer retries on direct — so fn
    // runs at least once on the broker (which fails) and succeeds on direct.
    assert.ok(calls >= 1, "the operation must run via the direct fallback after broker/busy");
    assert.equal(result.transport, "direct", "the operation must complete on the direct transport after a busy broker");
  } finally {
    busy.cleanup();
  }
});
