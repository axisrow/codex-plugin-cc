// Worktree isolation for write-capable rescue (write-race fix, openai#135).
// Ported from @peterdrier's openai/codex-plugin-cc#137, refactored to a
// "leave-branch" cleanup model.
//
// DESIGN: cleanupWorktreeSession NEVER removes the worktree or its branch.
//   - keep:   applies the tracked patch into repoRoot, then leaves the worktree
//              + branch in place for the user to inspect and remove manually.
//   - discard: no-op; leaves the worktree + branch in place.
//
// Why: the original capture-then-remove model (snapshot → apply → force-remove)
// had a deep fail-open class — `git add -A` skips ignored files (.env, dist/),
// dirty submodules and binary content can't be fully captured, and there is an
// inherent TOCTOU window between snapshot and remove. Each fix closed one edge
// and the next review cycle found another (4 cycles, 10 findings). Removing the
// Destroy path removes the entire class by construction. The cost is one manual
// `git worktree remove --force <path> && git branch -D <branch>` per rescue —
// acceptable for a rare, high-stakes operation whose whole point is write-safety.

import fs from "node:fs";
import path from "node:path";

import {
  createWorktree,
  getWorktreeDiff,
  applyWorktreePatch,
  ensureGitRepository
} from "./git.mjs";

export function createWorktreeSession(cwd) {
  const repoRoot = ensureGitRepository(cwd);
  // Warn (not fail) when worktrees accumulate — leave-branch never auto-removes,
  // so repeated rescue calls add .worktrees/codex-<ts>/ + branches indefinitely.
  // Threshold configurable via CODEX_WORKTREE_WARN_THRESHOLD (default 10).
  const worktreesDir = path.join(repoRoot, ".worktrees");
  const rawThreshold = process.env.CODEX_WORKTREE_WARN_THRESHOLD;
  const threshold = rawThreshold !== undefined && Number.isFinite(Number(rawThreshold))
    ? Number(rawThreshold)
    : 10;
  try {
    // SECURITY: lstat before readdirSync — if .worktrees is a symlink (crafted
    // repo), readdirSync would follow it and enumerate a host/network dir before
    // the #14 guard in createWorktree catches it. Skip the count if symlinked.
    if (fs.existsSync(worktreesDir) && !fs.lstatSync(worktreesDir).isSymbolicLink()) {
      const existing = fs.readdirSync(worktreesDir).filter((name) => name.startsWith("codex-"));
      if (existing.length >= threshold) {
        process.stderr.write(
          `[codex] Warning: ${existing.length} rescue worktrees exist in ${worktreesDir}. ` +
            `Remove the ones you no longer need:\n` +
            `  git worktree remove --force <path> && git branch -D <branch>\n` +
            `Or raise the threshold via CODEX_WORKTREE_WARN_THRESHOLD.\n`
        );
      }
    }
  } catch {
    // .worktrees doesn't exist yet, or unreadable — first run, no accumulation.
  }
  return createWorktree(repoRoot);
}

export function diffWorktreeSession(session) {
  return getWorktreeDiff(session.worktreePath, session.baseCommit);
}

// Returns the manual-removal hint included in every cleanup result. The worktree
// and branch are ALWAYS preserved; the user removes them after inspecting.
function preservationNote(session) {
  return `Worktree and branch preserved for inspection. Remove manually when done: git worktree remove --force ${session.worktreePath} && git branch -D ${session.branch}`;
}

/**
 * Leave-branch cleanup. Never destroys the worktree.
 *
 * keep=true:  applies the tracked patch into session.repoRoot (staged), leaves
 *             the worktree + branch in place. Returns {applied, detail}.
 * keep=false: no-op, leaves the worktree + branch in place. Returns {applied:false, detail}.
 *
 * In both cases the worktree survives — the caller renders preservationNote()
 * so the user knows how to remove it manually after inspecting.
 */
export function cleanupWorktreeSession(session, { keep = false } = {}) {
  if (keep) {
    const result = applyWorktreePatch(session.repoRoot, session.worktreePath, session.baseCommit);
    return {
      ...result,
      preserved: true,
      detail: `${result.detail} ${preservationNote(session)}`
    };
  }
  return {
    applied: false,
    preserved: true,
    detail: `Worktree discarded-from-transfer (left in place). ${preservationNote(session)}`
  };
}
