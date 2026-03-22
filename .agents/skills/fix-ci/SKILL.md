---
name: fix-ci
description: Run a local pnpm monorepo CI loop, fix failures, and stop only when the full sequence is green. Use when Codex is asked to fix CI, make a repository green, or resolve failures from `pnpm -w build`, `pnpm -w test:type`, `pnpm -w lint`, or `pnpm -w test`.
---

# Fix CI

Use this skill to drive a repository from red to green with the exact
command order `pnpm -w build`, `pnpm -w test:type`, `pnpm -w lint`,
`pnpm -w test`. Fix root causes in code, config, or tests and keep
iterating until the full ordered run passes.

## Workflow

1. Start at the repository root. Inspect `git status --short` so you do not
   overwrite unrelated user changes.
2. Run `scripts/run_fixci.sh all`. The script stops at the first failing step
   and writes logs under `.codex/fix-ci/<timestamp>/` by default.
3. Read the newest failing log. Fix the smallest real cause first; do not
   silence checks with `|| true`, blanket rule disables, `test.skip`, or broad
   type suppressions unless the user explicitly asks for that tradeoff.
4. Rerun the failing step with `scripts/run_fixci.sh <step>` until it passes.
   Supported single steps are `build`, `test:type`, `type`, `typecheck`,
   `lint`, and `test`.
5. Resume the sequence. If the fix touches shared types, build tooling, or
   test infrastructure, rerun from `build`; otherwise continue from the step
   that failed.
6. Finish only after `scripts/run_fixci.sh all` succeeds end-to-end.

## Operating Rules

- Prefer fixes in source, config, or tests over changes to CI commands.
- Keep edits narrow and consistent with the repository's existing patterns.
- Avoid changing lockfiles or adding dependencies unless they are required to
  make the current code pass.
- If the suite is blocked by missing dependencies, platform tooling, secrets,
  or external services, report the exact blocker and the command that exposed
  it.
- In the final response, report the commands you ran, the main fixes, and
  whether the full suite is green.

## Resource

- `scripts/run_fixci.sh`: Run one step or the full suite with timestamped logs.
