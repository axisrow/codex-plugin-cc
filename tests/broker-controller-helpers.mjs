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
