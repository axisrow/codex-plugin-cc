---
description: Run a Codex code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model|spark|sol|terra|luna>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Codex review through the shared built-in reviewer.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's INTENT exactly. You MAY rewrite a natural-language model or effort mention into the corresponding `--model` / `--effort` flag so the strict companion parser accepts it; do not otherwise change `--wait`, `--background`, `--base`, or `--scope`.
- `--model` and `--effort` select the Codex runtime for the review and are not focus text.
- Do not strip `--wait` or `--background` yourself.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/codex:review` is native-review only. It does not support staged-only review or unstaged-only review. Positional focus text is ignored by the native reviewer (for interface parity with `/codex:adversarial-review`); it does not abort the review.
- If the user needs custom review instructions or more adversarial framing, they should use `/codex:adversarial-review`.

Model/effort recognition (natural-language phrases):
- The user may write the model or effort in ANY natural language, including transliteration, typos, and non-Latin scripts (e.g. Cyrillic, Thai, Japanese). They will often omit the `--` flags entirely (e.g. "review model sol effort xhigh" or its equivalent in another language).
- Canonical model aliases (the only values `--model` accepts as short names): `spark` → gpt-5.3-codex-spark, `sol` → gpt-5.6-sol, `terra` → gpt-5.6-terra, `luna` → gpt-5.6-luna. A concrete model id (e.g. `gpt-5.4-mini`) is passed through unchanged.
- Canonical reasoning efforts (the only values `--effort` accepts): `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
- Before forwarding `$ARGUMENTS` to the companion, scan the raw arguments for model/effort intent in any language, map it to the canonical value above, and emit the result as `--model <canonical>` / `--effort <canonical>`. Use your judgment for language variants, transliteration, and typos — do not try to enumerate them. (Examples only, not exhaustive: a user writing "сол" or "sol" means `--model sol`; "ххай", "хай", "extra high", or "very high" means `--effort xhigh`.)
- `/codex:review` does not accept focus text. If, after extracting every recognized model/effort mention, the phrase is fully consumed, drop those words and forward only the resulting `--model`/`--effort` flags. If any non-flag words remain that you cannot map to model or effort, do NOT forward them (the companion will reject them). Instead use `AskUserQuestion` once with a suggested corrected command, e.g. `node ... review --model sol --effort xhigh`, and ask the user to confirm or clarify.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"`,
  description: "Codex review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Codex review started in the background. Check `/codex:status` for progress."
