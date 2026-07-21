import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { createBrokerController } from "../plugins/codex/scripts/lib/broker-controller.mjs";
import { makeTempDir } from "./helpers.mjs";

/**
 * Virtual clock with the same setTimeout/clearTimeout surface the controller
 * expects, plus advanceBy(ms) that fires due timers deterministically. Lets
 * idle/lifecycle tests advance time instead of sleeping in wall-clock.
 */
export class ManualClock {
  constructor() {
    this._now = 0;
    this._timers = [];
    this._nextHandle = 1;
  }

  setTimeout(fn, ms, ...args) {
    const handle = this._nextHandle++;
    this._timers.push({
      fireAt: this._now + Math.max(0, Number(ms) || 0),
      fn,
      args,
      handle,
      destroyed: false
    });
    return handle;
  }

  clearTimeout(handle) {
    const entry = this._timers.find((t) => t.handle === handle);
    if (entry) {
      entry.destroyed = true;
    }
  }

  /**
   * Advance virtual time, firing due timers in due-order. Fires the earliest
   * due timer, then re-evaluates (a timer may schedule another). Synchronous —
   * callers `await` the resulting broker promise (Node's microtask queue is
   * FIFO, so the controller's async idle callback resolves deterministically).
   */
  advanceBy(ms) {
    const target = this._now + Math.max(0, Number(ms) || 0);
    let guard = 0;
    while (guard < 10000) {
      guard += 1;
      const due = this._timers
        .filter((t) => !t.destroyed && t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt || a.handle - b.handle);
      if (due.length === 0) {
        break;
      }
      const next = due[0];
      this._now = next.fireAt;
      next.destroyed = true;
      try {
        next.fn(...next.args);
      } catch (error) {
        this._lastError = error;
      }
    }
    this._now = target;
  }
}

/**
 * Minimal in-process stand-in for the post-initialize app-server client.
 * Mirrors the surface the controller touches: request(), setNotificationHandler,
 * close(), exitPromise. `crash()` is the causal replacement for the fake-codex
 * fixture's boot-relative self-exit timer — tests call it AFTER broker.ready.
 */
export class FakeAppClient {
  constructor() {
    this.notificationHandler = null;
    this.closed = false;
    this.requests = [];
    this._handlers = new Map();
    this._resolveExit = null;
    this.exitPromise = new Promise((resolve) => {
      this._resolveExit = resolve;
    });
    this._exitResolved = false;
  }

  setNotificationHandler(fn) {
    this.notificationHandler = fn;
  }

  request(method, params) {
    this.requests.push({ method, params });
    if (this._exitResolved) {
      return Promise.reject(new Error("codex app-server client is closed."));
    }
    const handler = this._handlers.get(method);
    if (handler) {
      return Promise.resolve(handler(params));
    }
    return Promise.resolve({});
  }

  notify() {}

  /** Register a canned response for a method. Return a value or a Promise. */
  on(method, fn) {
    this._handlers.set(method, fn);
    return this;
  }

  /** Test-driven app-server notification (e.g. turn/completed). */
  emitNotification(message) {
    if (this.notificationHandler) {
      this.notificationHandler(message);
    }
  }

  close() {
    this.closed = true;
    return Promise.resolve();
  }

  /** Resolve exitPromise — simulates the app-server child dying. */
  crash() {
    this._exitResolved = true;
    this._resolveExit(undefined);
  }
}

/**
 * Wire createBrokerController in-process against a temp-dir unix socket with
 * a ManualClock and a FakeAppClient. Real net.createServer is used so the
 * JSONL framing, socket close/error paths, and concurrency guard are exercised
 * — without spawning a process.
 *
 * connectClient/sendRpc drive real net sockets against the in-process server.
 */
export async function spawnInProcessBroker({ appClient, idleTimeoutMs = 0, endpoint, pidFile } = {}) {
  const clock = new ManualClock();
  const sessionDir = makeTempDir("broker-test-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const resolvedPidFile = pidFile ?? path.join(sessionDir, "broker.pid");
  const resolvedEndpoint = endpoint ?? `unix:${socketPath}`;
  const fakeAppClient = appClient ?? new FakeAppClient();

  const broker = await createBrokerController({
    endpoint: resolvedEndpoint,
    pidFile: resolvedPidFile,
    idleTimeoutMs,
    pid: 12345,
    appClientFactory: async () => fakeAppClient,
    clock
  });

  function connectClient() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ path: socketPath });
      sock.setEncoding("utf8");
      sock.on("connect", () => resolve(sock));
      sock.on("error", reject);
    });
  }

  function sendRpc(message) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ path: socketPath });
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("connect", () => sock.write(`${JSON.stringify(message)}\n`));
      sock.on("data", (chunk) => {
        buf += chunk;
        const i = buf.indexOf("\n");
        if (i !== -1) {
          try {
            resolve(JSON.parse(buf.slice(0, i)));
          } catch (error) {
            reject(error);
          }
          sock.end();
        }
      });
      sock.on("error", reject);
    });
  }

  return {
    broker,
    clock,
    appClient: fakeAppClient,
    socketPath,
    pidFile: resolvedPidFile,
    connectClient,
    sendRpc
  };
}

/**
 * A real net.createServer that accepts connections but never answers any
 * request — simulates a wedged broker (busy with a long-running request and
 * never reaching the second socket's data). Drives the client-side connect +
 * initialize path with no server response, exposing any missing deadline.
 */
export async function spawnWedgedServer() {
  const sessionDir = makeTempDir("broker-wedged-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const connections = new Set();
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    // Intentionally ignore "data": the broker is wedged and never responds.
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    cleanup() {
      // Destroy accepted sockets so the wedged client's request rejects and
      // the process can exit. server.close() alone would wait for them.
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      try {
        server.close();
      } catch {}
      try {
        fs.unlinkSync(socketPath);
      } catch {}
    }
  };
}

/**
 * A real net.createServer that speaks just enough JSON-RPC to pass the broker
 * handshake, then returns BROKER_BUSY_RPC_CODE (-32001) for every subsequent
 * request — simulates a shared broker that accepted initialize while busy with
 * another in-flight stream. Drives withAppServer's post-handshake busy
 * fallback, which must retry the operation on a direct (non-broker) client.
 */
export async function spawnBusyBroker() {
  const sessionDir = makeTempDir("broker-busy-");
  const socketPath = path.join(sessionDir, "broker.sock");
  const connections = new Set();
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === undefined) {
          continue;
        }
        if (message.method === "initialize") {
          socket.write(`${JSON.stringify({ id: message.id, result: { userAgent: "busy-broker" } })}\n`);
        } else {
          socket.write(`${JSON.stringify({ id: message.id, error: { code: -32001, message: "Shared Codex broker is busy." } })}\n`);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    cleanup() {
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      try {
        server.close();
      } catch {}
      try {
        fs.unlinkSync(socketPath);
      } catch {}
    }
  };
}
