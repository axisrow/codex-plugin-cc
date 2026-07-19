import {
  createWorktree,
  removeWorktree,
  deleteWorktreeBranch,
  getWorktreeDiff,
  applyWorktreePatch,
  hasIgnoredChanges,
  ensureGitRepository
} from "./git.mjs";

export function createWorktreeSession(cwd) {
  const repoRoot = ensureGitRepository(cwd);
  return createWorktree(repoRoot);
}

export function diffWorktreeSession(session) {
  return getWorktreeDiff(session.worktreePath, session.baseCommit);
}

export function cleanupWorktreeSession(session, { keep = false } = {}) {
  if (keep) {
    const result = applyWorktreePatch(session.repoRoot, session.worktreePath, session.baseCommit);
    if (!result.applied && result.detail !== "No changes to apply.") {
      return result;
    }
    // "No changes to apply" via `git add -A` skips git-ignored paths. If the
    // worktree holds ignored-only work (e.g. Codex wrote .env, dist/, build
    // artifacts), force-removing it would irreversibly destroy it. Preserve the
    // worktree + branch and surface the situation instead. (openai#137 review.)
    if (!result.applied && hasIgnoredChanges(session.worktreePath)) {
      return {
        applied: false,
        detail: `No tracked changes to apply, but the worktree has ignored files (e.g. .env, dist/) at ${session.worktreePath}. Preserving the worktree and branch ${session.branch} — inspect and copy them manually before removing.`
      };
    }
    removeWorktree(session.repoRoot, session.worktreePath);
    deleteWorktreeBranch(session.repoRoot, session.branch);
    return result;
  }
  removeWorktree(session.repoRoot, session.worktreePath);
  deleteWorktreeBranch(session.repoRoot, session.branch);
  return { applied: false, detail: "Worktree discarded." };
}
