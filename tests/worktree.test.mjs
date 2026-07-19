import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorktreeSession,
  diffWorktreeSession,
  cleanupWorktreeSession
} from "../plugins/codex/scripts/lib/worktree.mjs";
import { getWorktreeDiff } from "../plugins/codex/scripts/lib/git.mjs";
import { renderWorktreeTaskResult } from "../plugins/codex/scripts/lib/render.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function gitStdout(cwd, args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commitFile(cwd, fileName = "app.js", contents = "export const value = 1;\n") {
  fs.writeFileSync(path.join(cwd, fileName), contents);
  assert.equal(run("git", ["add", fileName], { cwd }).status, 0);
  const commit = run("git", ["commit", "-m", "init"], { cwd });
  assert.equal(commit.status, 0, commit.stderr);
}

function createRepoWithInitialCommit() {
  const repoRoot = makeTempDir();
  initGitRepo(repoRoot);
  commitFile(repoRoot);
  return { repoRoot };
}

// Manual worktree+branch cleanup for test fixtures (the production library
// leaves them in place by design; tests must tidy up themselves).
function removeSession(session) {
  if (!session) {
    return;
  }
  try {
    run("git", ["worktree", "remove", "--force", session.worktreePath], { cwd: session.repoRoot });
  } catch {
    // already gone
  }
  try {
    run("git", ["branch", "-D", session.branch], { cwd: session.repoRoot });
  } catch {
    // already gone
  }
}

test("createWorktreeSession returns session with worktreePath, branch, repoRoot, baseCommit", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    // macOS symlinks /var → /private/var; git canonicalizes repoRoot while
    // makeTempDir returns the symlinked path. Compare via realpath like #497.
    assert.equal(fs.realpathSync(session.repoRoot), fs.realpathSync(repoRoot));
    assert.match(session.branch, /^codex\/\d+$/);
    assert.equal(fs.realpathSync(session.worktreePath), fs.realpathSync(path.join(repoRoot, ".worktrees", `codex-${session.timestamp}`)));
    assert.ok(session.baseCommit);
    assert.ok(fs.existsSync(session.worktreePath));
  } finally {
    removeSession(session);
  }
});

test("createWorktreeSession baseCommit matches repo HEAD at creation time", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const headAtCreation = gitStdout(repoRoot, ["rev-parse", "HEAD"]);
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(repoRoot, "app.js"), "export const value = 2;\n");
    assert.equal(run("git", ["add", "app.js"], { cwd: repoRoot }).status, 0);
    const commit = run("git", ["commit", "-m", "repo-root change"], { cwd: repoRoot });
    assert.equal(commit.status, 0, commit.stderr);

    const newHead = gitStdout(repoRoot, ["rev-parse", "HEAD"]);
    assert.equal(session.baseCommit, headAtCreation);
    assert.notEqual(newHead, session.baseCommit);
  } finally {
    removeSession(session);
  }
});

test("diffWorktreeSession captures uncommitted changes in the worktree", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(session.worktreePath, "app.js"), "export const value = 2;\n");

    const diff = diffWorktreeSession(session);

    assert.deepEqual(diff, getWorktreeDiff(session.worktreePath, session.baseCommit));
    assert.notEqual(diff.stat, "");
    assert.match(diff.stat, /app\.js/);
  } finally {
    removeSession(session);
  }
});

test("diffWorktreeSession captures new untracked files in the worktree", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(session.worktreePath, "newfile.js"), "export const added = true;\n");

    const diff = diffWorktreeSession(session);

    assert.notEqual(diff.stat, "");
    assert.match(diff.stat, /newfile\.js/);
    assert.match(diff.patch, /added = true/);
  } finally {
    removeSession(session);
  }
});

test("diffWorktreeSession returns empty when no changes made", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    const diff = diffWorktreeSession(session);
    assert.deepEqual(diff, { stat: "", patch: "" });
  } finally {
    removeSession(session);
  }
});

// ---------------------------------------------------------------------------
// Leave-branch invariant: the worktree + branch ALWAYS survive cleanup.
// These replace the old capture-then-remove tests. Under leave-branch there is
// no Destroy path, so the whole fail-open class (ignored/mixed/submodule/TOCTOU)
// is closed by construction — the assertions below are the proof.
// ---------------------------------------------------------------------------

test("keep applies tracked changes to repoRoot AND preserves the worktree + branch", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(session.worktreePath, "newfile.js"), "export const added = true;\n");

    const result = cleanupWorktreeSession(session, { keep: true });

    assert.equal(result.applied, true);
    assert.equal(result.preserved, true);
    assert.ok(fs.existsSync(path.join(repoRoot, "newfile.js")), "tracked change applied to repoRoot");
    // INVARIANT: worktree + branch still exist.
    assert.equal(fs.existsSync(session.worktreePath), true, "worktree preserved");
    const branches = gitStdout(repoRoot, ["branch", "--list", session.branch]);
    assert.match(branches, new RegExp(session.branch), "branch preserved");
  } finally {
    removeSession(session);
  }
});

test("keep with only ignored changes preserves the worktree (ignored files are NOT lost)", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "dist/\n");
  assert.equal(run("git", ["add", ".gitignore"], { cwd: repoRoot }).status, 0);
  assert.equal(run("git", ["commit", "-m", "gitignore"], { cwd: repoRoot }).status, 0);

  const session = createWorktreeSession(repoRoot);

  try {
    fs.mkdirSync(path.join(session.worktreePath, "dist"), { recursive: true });
    fs.writeFileSync(path.join(session.worktreePath, "dist", "artifact.txt"), "precious\n");

    const result = cleanupWorktreeSession(session, { keep: true });

    // No tracked changes to apply, but the ignored artifact MUST survive.
    assert.equal(result.preserved, true);
    assert.equal(fs.existsSync(session.worktreePath), true);
    assert.equal(
      fs.readFileSync(path.join(session.worktreePath, "dist", "artifact.txt"), "utf8"),
      "precious\n",
      "ignored artifact preserved (not destroyed)"
    );
  } finally {
    removeSession(session);
  }
});

test("keep with mixed tracked + ignored changes applies tracked AND preserves ignored", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "dist/\n");
  assert.equal(run("git", ["add", ".gitignore"], { cwd: repoRoot }).status, 0);
  assert.equal(run("git", ["commit", "-m", "gitignore"], { cwd: repoRoot }).status, 0);

  const session = createWorktreeSession(repoRoot);

  try {
    // Tracked edit + ignored artifact at the same time.
    fs.writeFileSync(path.join(session.worktreePath, "app.js"), "export const value = 2;\n");
    fs.mkdirSync(path.join(session.worktreePath, "dist"), { recursive: true });
    fs.writeFileSync(path.join(session.worktreePath, "dist", "build.txt"), "compiled\n");

    const result = cleanupWorktreeSession(session, { keep: true });

    assert.equal(result.applied, true, "tracked change applied");
    assert.equal(result.preserved, true);
    assert.match(fs.readFileSync(path.join(repoRoot, "app.js"), "utf8"), /value = 2/);
    // INVARIANT: worktree still exists, ignored artifact intact.
    assert.equal(fs.existsSync(session.worktreePath), true);
    assert.equal(
      fs.readFileSync(path.join(session.worktreePath, "dist", "build.txt"), "utf8"),
      "compiled\n",
      "ignored artifact preserved alongside tracked apply"
    );
  } finally {
    removeSession(session);
  }
});

test("discard is a no-op that preserves the worktree + branch (never destroys)", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(session.worktreePath, "app.js"), "export const value = 2;\n");

    const result = cleanupWorktreeSession(session, { keep: false });

    assert.equal(result.applied, false);
    assert.equal(result.preserved, true);
    // INVARIANT: discard does NOT remove anything. The work + branch survive.
    assert.equal(fs.existsSync(session.worktreePath), true, "worktree preserved on discard");
    assert.equal(
      fs.readFileSync(path.join(session.worktreePath, "app.js"), "utf8"),
      "export const value = 2;\n",
      "discarded work still present in the preserved worktree"
    );
    const branches = gitStdout(repoRoot, ["branch", "--list", session.branch]);
    assert.match(branches, new RegExp(session.branch), "branch preserved on discard");
  } finally {
    removeSession(session);
  }
});

test("keep round-trips a non-UTF-8 byte (0xff) without corruption (byte-preserving patch)", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(path.join(session.worktreePath, "binary.bin"), Buffer.from([0xff, 0x00, 0x41, 0xff]));

    const result = cleanupWorktreeSession(session, { keep: true });
    assert.equal(result.applied, true);

    const applied = fs.readFileSync(path.join(repoRoot, "binary.bin"));
    assert.deepEqual(
      Array.from(applied),
      [0xff, 0x00, 0x41, 0xff],
      `binary bytes must round-trip exactly; U+FFFD corruption would show 0xEF 0xBF 0xBD`
    );
  } finally {
    removeSession(session);
  }
});

test("renderWorktreeTaskResult renders the manual-remove instructions (no destructive command)", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    const diff = { stat: " app.js | 2 +-\n 1 file changed", patch: "..." };
    const output = renderWorktreeTaskResult({ rendered: "task output" }, session, diff, { jobId: "job-123" });

    assert.match(output, /Worktree \(preserved\)/);
    assert.match(output, /git worktree remove --force/);
    assert.match(output, /git branch -D/);
    // Inspection command must be HEAD/base-based (shows staged work) — plain
    // `git diff` hides staged changes and a user could force-remove thinking
    // the worktree is empty (openai#137 review finding).
    assert.match(output, /diff .*--binary/);
    assert.match(output, new RegExp(`diff ${session.baseCommit}`));
    assert.match(output, /ignored/i);
    // No keep/discard CLI commands — leave-branch has no destructive action.
    assert.doesNotMatch(output, /--action (keep|discard)/);
  } finally {
    removeSession(session);
  }
});

// SECURITY regression (#14): a symlink at `.worktrees` must NOT be followed.
// Without the guard, recursive mkdirSync follows the symlink and `git worktree add`
// populates the symlink target — a crafted repo (or a prior malicious run) could
// redirect the Codex workspace-write root into ~/.ssh / ~/.config / etc.
test("createWorktreeSession refuses a symlink at .worktrees (no host-location redirect)", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const attackerDest = makeTempDir("worktree-attack-dest-");

  // Plant the hostile symlink: .worktrees -> attackerDest (outside repoRoot).
  fs.symlinkSync(attackerDest, path.join(repoRoot, ".worktrees"));

  assert.throws(
    () => createWorktreeSession(repoRoot),
    /symlink/i,
    "must refuse when .worktrees is a symlink"
  );

  // The attacker's destination must NOT have been populated.
  assert.deepEqual(
    fs.readdirSync(attackerDest),
    [],
    "attacker destination must remain empty (no worktree written through the symlink)"
  );
});

// Regression: rescue changes are STAGED (getWorktreeDiff/applyWorktreePatch run
// git add -A). The rendered inspection command must be HEAD/base-based so it
// shows staged work — plain `git diff` shows only unstaged and could read empty,
// tricking the user into force-removing a worktree that holds real staged work
// (openai#137 review finding). Assert the command references baseCommit, not a
// bare `diff`.
test("renderWorktreeTaskResult inspection command references baseCommit (staged-aware)", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    const output = renderWorktreeTaskResult({ rendered: "" }, session, { stat: "", patch: "" });
    // The bare `git diff` (unstaged-only) must NOT be the inspection command.
    assert.doesNotMatch(output, /git -C [^\s]+ diff\b(?! )/);
    // baseCommit must appear in a diff command (HEAD-based => shows staged).
    assert.match(output, new RegExp(`diff ${session.baseCommit}`));
  } finally {
    removeSession(session);
  }
});

// SECURITY regression (#15): a symlink created in the worktree is captured as a
// mode-120000 diff entry. Without the guard, `git apply --index` would recreate
// the symlink in repoRoot pointing at an attacker-chosen host path → host-file
// exfil/append. keep must detect mode 120000 in the patch and refuse to apply,
// leaving the worktree in place.
test("keep refuses to apply a patch containing a symlink (mode 120000) and preserves the worktree", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    // Plant a symlink in the worktree pointing at an absolute host path.
    fs.symlinkSync("/etc/passwd", path.join(session.worktreePath, "steal"));

    const result = cleanupWorktreeSession(session, { keep: true });

    assert.equal(result.applied, false);
    assert.match(result.detail, /symlinks/i);
    // The symlink must NOT have been recreated in repoRoot.
    assert.equal(fs.existsSync(path.join(repoRoot, "steal")), false, "symlink not replayed into repoRoot");
    // Worktree preserved (leave-branch).
    assert.equal(result.preserved, true);
  } finally {
    removeSession(session);
  }
});

// SECURITY regression (#15, false-positive guard): a regular file whose CONTENT
// happens to contain the literal "mode 120000" string (e.g. documentation of git
// modes) must NOT trip the symlink guard. Only real diff mode headers
// ("new file mode 120000" etc.) are symlinks. The regex matches line-anchored
// mode headers, not arbitrary content.
test("keep applies a regular file whose content literally mentions mode 120000 (no false positive)", () => {
  const { repoRoot } = createRepoWithInitialCommit();
  const session = createWorktreeSession(repoRoot);

  try {
    fs.writeFileSync(
      path.join(session.worktreePath, "modes.md"),
      'Git emits "new file mode 120000" for symlinks.\n'
    );

    const result = cleanupWorktreeSession(session, { keep: true });

    assert.equal(result.applied, true, "regular file applied despite the literal mode string in content");
    assert.match(fs.readFileSync(path.join(repoRoot, "modes.md"), "utf8"), /mode 120000/);
  } finally {
    removeSession(session);
  }
});
