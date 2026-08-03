import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED_JOBS_URL = pathToFileURL(
  path.join(ROOT, "plugins", "codex", "scripts", "lib", "tracked-jobs.mjs")
).href;

function seedJob(workspace, job) {
  writeJobFile(workspace, job.id, job);
  upsertJob(workspace, job);
}

test("registerWorkerCrashGuard marks the job failed when the worker dies on an unhandled rejection", () => {
  const workspace = makeTempDir();
  seedJob(workspace, { id: "job-crash", status: "running", phase: "delegating", pid: process.pid, logFile: null });

  const workerFile = path.join(makeTempDir(), "crashing-worker.mjs");
  fs.writeFileSync(
    workerFile,
    [
      `import { registerWorkerCrashGuard } from ${JSON.stringify(TRACKED_JOBS_URL)};`,
      "registerWorkerCrashGuard(process.argv[2], process.argv[3], null);",
      'Promise.reject(new Error("boom"));',
      "setTimeout(() => {}, 5000);",
      ""
    ].join("\n"),
    "utf8"
  );

  const result = run(process.execPath, [workerFile, workspace, "job-crash"]);

  assert.equal(result.status, 1);
  const stored = readJobFile(resolveJobFile(workspace, "job-crash"));
  assert.equal(stored.status, "failed");
  assert.match(stored.errorMessage, /unhandledRejection/);
  assert.match(stored.errorMessage, /boom/);
});

test("registerWorkerCrashGuard does not rewrite a cancelled job when the worker is SIGTERMed", async () => {
  const workspace = makeTempDir();
  // Simulate handleCancel having already written the terminal state before the
  // worker processes the teardown SIGTERM it delivered.
  seedJob(workspace, { id: "job-cancelled", status: "cancelled", phase: "cancelled", pid: null, errorMessage: "Cancelled by user." });

  const workerFile = path.join(makeTempDir(), "long-worker.mjs");
  fs.writeFileSync(
    workerFile,
    [
      `import { registerWorkerCrashGuard } from ${JSON.stringify(TRACKED_JOBS_URL)};`,
      "registerWorkerCrashGuard(process.argv[2], process.argv[3], null);",
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1000);",
      ""
    ].join("\n"),
    "utf8"
  );

  const child = spawn(process.execPath, [workerFile, workspace, "job-cancelled"], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("ready")) {
        resolve();
      }
    });
    child.on("error", reject);
  });

  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  const { signal } = await exited;

  assert.equal(signal, "SIGTERM");
  const stored = readJobFile(resolveJobFile(workspace, "job-cancelled"));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.errorMessage, "Cancelled by user.");
});
