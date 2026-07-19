import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree, runCommand } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args, options) {
      captured = { command, args, options };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"],
    options: {
      cwd: undefined,
      env: undefined,
      shell: false
    }
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree recognizes a missing Windows process with localized output", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "Localized taskkill error.",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      const error = new Error("No such process");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "taskkill");
});

// Regression: a child killed by a signal OR that failed to spawn returns
// status:null from spawnSync. runCommand must NOT normalize that to status:0 —
// callers checking status===0 would mistake a killed/missing git op (e.g. git
// apply killed mid-run, or git missing) for success. For worktree patch capture/
// apply that means false-success while the work holds un-captured changes.
test("runCommand reports a signal-terminated child as failed (non-zero status)", () => {
  const result = runCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
  assert.ok(result.signal !== null, `expected a signal, got signal=${result.signal}`);
  assert.notEqual(result.status, 0, `signal-terminated child must not report status 0, got ${result.status}`);
});

test("runCommand reports a spawn failure (ENOENT) as failed (non-zero status)", () => {
  const result = runCommand("/nonexistent-codex-binary-xyz", []);
  assert.ok(result.error, `expected an error, got ${result.error}`);
  assert.notEqual(result.status, 0, `spawn failure must not report status 0, got ${result.status}`);
});
