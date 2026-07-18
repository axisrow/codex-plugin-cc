#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { CodexAppServerClient } from "./lib/app-server.mjs";
import { createBrokerController } from "./lib/broker-controller.mjs";

const BROKER_IDLE_TIMEOUT_ENV = "CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS";
const DEFAULT_BROKER_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
// When set (by the smoke-test harness), the CLI mirrors `ready`/`stopped` over
// its IPC channel so the test has a causal readiness barrier instead of socket
// probing. Production leaves this unset.
const BROKER_IPC_ENV = "CODEX_COMPANION_BROKER_IPC";

function resolveIdleTimeoutMs(env = process.env) {
  const rawValue = env[BROKER_IDLE_TIMEOUT_ENV];
  if (rawValue == null || rawValue === "") {
    return DEFAULT_BROKER_IDLE_TIMEOUT_MS;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_BROKER_IDLE_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint", "model", "effort"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const ipcEnabled = process.env[BROKER_IPC_ENV] === "1";

  const broker = await createBrokerController({
    endpoint: String(options.endpoint),
    pidFile,
    idleTimeoutMs: resolveIdleTimeoutMs(),
    pid: process.pid,
    appClientFactory: () =>
      CodexAppServerClient.connect(cwd, {
        disableBroker: true,
        model: options.model,
        effort: options.effort
      })
  });

  if (ipcEnabled && typeof process.send === "function") {
    broker.ready.then(() => process.send({ type: "ready" }));
  }

  process.on("SIGTERM", () => broker.signalShutdown("signal"));
  process.on("SIGINT", () => broker.signalShutdown("signal"));

  const result = await broker.stopped;

  if (ipcEnabled && typeof process.send === "function") {
    process.send({ type: "stopped", reason: result.reason, exitCode: result.exitCode });
  }

  process.exit(result.exitCode);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
