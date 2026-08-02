import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { makeTempDir } from "./helpers.mjs";
import { spawnStubbornBroker } from "./broker-controller-helpers.mjs";

// Codex-review finding on PR #48 (#47 finding 2): BrokerCodexAppServerClient
// .close() called socket.end() and awaited exitPromise with no fallback. A
// peer that completes the handshake, answers requests, but then stays alive
// and ignores the client's FIN (socket.end()) left close() -- and therefore
// any onTimeout handler in codex.mjs that calls client.close() -- hanging
// indefinitely. A caller's own request-level timeoutMs is not a real bound
// if close() itself can hang past it. This is the regression test for the
// BROKER_CLOSE_GRACE_MS fallback in app-server.mjs's close().
test("close() does not hang when the broker peer ignores the FIN (#47 finding 2 follow-up)", async () => {
  const stubborn = await spawnStubbornBroker();
  const cwd = makeTempDir();

  let client;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      brokerEndpoint: `unix:${stubborn.socketPath}`,
      brokerConnectTimeoutMs: 2000,
      brokerInitializeTimeoutMs: 2000
    });
    assert.equal(client.transport, "broker", "must have connected over the broker transport");

    // A normal request completes -- the peer is not wedged, just stubborn
    // about closing.
    await client.request("turn/interrupt", { threadId: "t1", turnId: "r1" }, { timeoutMs: 2000 });

    const outcome = await Promise.race([
      client.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("HANG"), 3000))
    ]);

    assert.notEqual(outcome, "HANG", "close() hung forever on a peer that never reciprocates FIN");
    assert.equal(outcome, "closed", "close() must resolve once the grace-period fallback force-destroys the socket");
  } finally {
    stubborn.cleanup();
  }
});
