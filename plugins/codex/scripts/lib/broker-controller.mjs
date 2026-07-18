import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { parseBrokerEndpoint } from "./broker-endpoint.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

export const BROKER_BUSY_RPC_CODE = -32001;

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

// Default dependency implementations (production). The controller never imports
// node:process / node:fs directly — the CLI injects process-bound values, and
// tests inject fakes. This seam is what makes the lifecycle testable in-process.
const realClock = {
  setTimeout: (fn, ms, ...args) => setTimeout(fn, ms, ...args),
  clearTimeout: (handle) => clearTimeout(handle)
};

const realServerFactory = {
  create(connectionListener) {
    return net.createServer(connectionListener);
  }
};

const realFileSystem = {
  existsSync: (p) => fs.existsSync(p),
  unlinkSync: (p) => fs.unlinkSync(p),
  mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
  writeFileSync: (p, content, enc) => fs.writeFileSync(p, content, enc)
};

/**
 * Create an in-process broker lifecycle controller.
 *
 * The controller owns the broker state machine (idle timer, socket routing,
 * shutdown, child-exit handling). It never calls process.exit — termination is
 * signalled via the `stopped` promise, which the CLI awaits and maps to an exit
 * code. Tests drive this directly with injected dependencies (fake app client,
 * manual clock), so lifecycle assertions are causal, not wall-clock-based.
 *
 * @param {object} options
 * @param {string} options.endpoint           - "unix:/path" or named-pipe endpoint.
 * @param {string|null} options.pidFile       - absolute pidfile path or null.
 * @param {number} options.idleTimeoutMs      - idle self-shutdown delay; 0 disables.
 * @param {number} [options.pid]              - pid written to pidFile (default process.pid at CLI).
 * @param {() => Promise<AppServerClientLike>} options.appClientFactory - builds the app-server client.
 * @param {object} [options.clock]            - { setTimeout, clearTimeout } (default real).
 * @param {object} [options.serverFactory]    - { create(connectionListener) } (default net.createServer).
 * @param {object} [options.fileSystem]       - fs shim (default real fs).
 * @returns {Promise<BrokerController>}
 */
export async function createBrokerController({
  endpoint,
  pidFile,
  idleTimeoutMs,
  pid = process.pid,
  appClientFactory,
  clock = realClock,
  serverFactory = realServerFactory,
  fileSystem = realFileSystem
}) {
  const listenTarget = parseBrokerEndpoint(endpoint);

  if (pidFile) {
    fileSystem.mkdirSync(path.dirname(pidFile), { recursive: true });
    fileSystem.writeFileSync(pidFile, `${pid}\n`, "utf8");
  }

  const appClient = await appClientFactory();

  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();
  let idleTimer = null;
  let shuttingDown = false;
  let terminating = false;
  let stopped = false;

  // Causal event resolvers — tests await these to establish happens-before.
  let resolveReady;
  let resolveStopped;
  let resolveClientAccepted;
  let resolveClientClosed;
  let resolveIdleArmed;
  let resolveClosing;

  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const stoppedPromise = new Promise((resolve) => {
    resolveStopped = resolve;
  });
  const clientAcceptedPromise = new Promise((resolve) => {
    resolveClientAccepted = resolve;
  });
  const clientClosedPromise = new Promise((resolve) => {
    resolveClientClosed = resolve;
  });
  const idleArmedPromise = new Promise((resolve) => {
    resolveIdleArmed = resolve;
  });
  const closingPromise = new Promise((resolve) => {
    resolveClosing = resolve;
  });

  function requestExit(exitCode, reason) {
    if (stopped) {
      return;
    }
    stopped = true;
    cancelIdleShutdown();
    resolveStopped({ reason, exitCode });
  }

  function cancelIdleShutdown() {
    if (idleTimer) {
      clock.clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    resolveClosing({ reason: "closing" });
    cancelIdleShutdown();
    // Stop accepting connections before awaiting child cleanup. Otherwise a
    // reconnect can slip into the async shutdown window and inherit a closing
    // app-server client.
    const serverClosed = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    // Bound the wait so a peer that never closes its socket (e.g. a wedged
    // client) cannot keep shutdown — and therefore the broker's exit — hung
    // indefinitely. Force-destroy any lingering sockets after a short grace.
    await Promise.race([
      serverClosed,
      new Promise((resolve) => clock.setTimeout(resolve, 1000))
    ]).finally(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
    });
    if (listenTarget.kind === "unix" && fileSystem.existsSync(listenTarget.path)) {
      fileSystem.unlinkSync(listenTarget.path);
    }
    if (pidFile && fileSystem.existsSync(pidFile)) {
      fileSystem.unlinkSync(pidFile);
    }
  }

  function scheduleIdleShutdown(server) {
    cancelIdleShutdown();
    if (shuttingDown || idleTimeoutMs === 0 || sockets.size > 0 || activeRequestSocket || activeStreamSocket) {
      return;
    }

    resolveIdleArmed({ reason: "idle-armed" });
    idleTimer = clock.setTimeout(async () => {
      idleTimer = null;
      if (sockets.size > 0 || activeRequestSocket || activeStreamSocket) {
        return;
      }
      await shutdown(server);
      requestExit(0, "idle");
    }, idleTimeoutMs);
  }

  appClient.setNotificationHandler(routeNotification);

  const server = serverFactory.create((socket) => {
    if (shuttingDown) {
      // An already-accepted connection event can be delivered after
      // server.close(). Reject it decisively and absorb a simultaneous reset.
      socket.on("error", () => {});
      socket.destroy();
      return;
    }
    cancelIdleShutdown();
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          if (activeRequestSocket || activeStreamSocket) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
            });
            continue;
          }
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          requestExit(0, "broker/shutdown");
          continue;
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        resolveClientAccepted({ reason: "client-accepted" });

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      if (sockets.size === 0) {
        resolveClientClosed({ reason: "client-closed" });
      }
      scheduleIdleShutdown(server);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      if (sockets.size === 0) {
        resolveClientClosed({ reason: "client-closed" });
      }
      scheduleIdleShutdown(server);
    });
  });

  // The broker proxies every request to its single app-server child. If that
  // child exits, appClient can no longer serve: request() writes to a closed
  // stdin and its promise never resolves, so a caller hangs forever (a
  // submitted turn/review sits at "starting" and is never answered). The broker
  // would otherwise stay up as a zombie because its listening socket still
  // accepts connections, so ensureBrokerSession() keeps reusing it. Terminate
  // when the child exits so the stale socket/pid-file are removed and the next
  // connect spawns a fresh, working broker.
  appClient.exitPromise.then(() => {
    if (shuttingDown || terminating) {
      return;
    }
    terminating = true;
    shutdown(server).finally(() => requestExit(1, "app-server-exit"));
  });

  // Listen, then resolve `ready` once the listener is up AND the exitPromise
  // handler above is armed — so a caller awaiting `ready` is guaranteed the
  // broker can both serve and observe child death.
  await new Promise((resolve) => {
    server.listen(listenTarget.path, () => {
      scheduleIdleShutdown(server);
      resolve();
    });
  });
  resolveReady({ reason: "ready" });

  return {
    ready: readyPromise,
    stopped: stoppedPromise,
    clientAccepted: clientAcceptedPromise,
    clientClosed: clientClosedPromise,
    idleArmed: idleArmedPromise,
    closing: closingPromise,
    requestExit,
    signalShutdown(reason) {
      // Fire-and-forget; the CLI awaits `stopped` and maps exitCode.
      // Idempotent via `shutdown()`'s shuttingDown guard + requestExit's stopped guard.
      shutdown(server).finally(() => requestExit(0, reason));
    },
    listenTarget: () => listenTarget,
    server: () => server
  };
}
