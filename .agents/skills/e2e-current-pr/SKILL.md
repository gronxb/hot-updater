---
name: e2e-current-pr
description: Generate and execute PR-aware OTA E2E scenarios for `examples/v0.85.0` by diffing the checked-out branch against its PR base branch or default branch, inferring the affected runtime, rollout, and recovery surfaces, and then running the scenario through `../e2e`. Use when the caller wants current-branch OTA validation without hand-writing the scenario.
---

# E2E Current PR

Use this skill from the repository root on the branch that should be validated.

Always load and follow [$e2e](../e2e/SKILL.md). This skill owns base-branch
detection, diff review, scenario selection, and platform choice. `../e2e`
owns build, deploy, device interaction, and evidence gathering.

## Workflow

1. Run `./.agents/skills/e2e-current-pr/scripts/summarize_pr_diff.py`.
2. If the caller gave an explicit base branch, pass `--base <branch>`. Otherwise
   let the script detect the base from `gh pr view` and fall back to the repo
   default branch.
3. Read the summary, then inspect the changed files that look OTA-relevant. Do
   not rely on the tags alone if the patch excerpt points at risky runtime code.
4. Translate the diff into a concrete scenario before execution. State the base
   branch, changed risk areas, chosen platform scope, stable assertions, and
   crash assertions if any. Then execute it with [$e2e](../e2e/SKILL.md).
5. Run one platform at a time. Default to both platforms when shared runtime or
   cross-platform native code changes.
6. Report the chosen scenario, evidence, and any surfaces you intentionally
   skipped.

## Scenario Selection

- Use a stable-only OTA scenario when the diff is limited to visible JS or UI
  behavior and there is no sign of rollback, crash handling, launch reporting,
  bundle-store, or native boot logic changes.
- Add a crash-and-recovery phase when the diff touches recovery or launch-path
  logic such as `packages/core`, `packages/react-native`, native
  `examples/v0.85.0/ios` or `examples/v0.85.0/android` boot code, or files
  mentioning rollback, crash history, launch reports, `notifyAppReady`, or
  bundle-store behavior.
- Prefer iOS first when the diff is iOS-only. Prefer Android first when the
  diff is Android-only. Run both platforms when shared packages, deploy logic,
  or cross-platform example code changes.
- If the diff only changes docs, CI, or tooling with no OTA runtime impact,
  stop and explain that this skill does not have a meaningful E2E scenario to
  run.
- When the changed behavior is not already visible in the example UI, add the
  smallest temporary proof point needed for the scenario, deploy it, and revert
  that patch immediately after the deploy finishes.

## Diff Review Rules

- Treat the script output as triage, not as the final verdict.
- Read the actual patch for every changed file that could affect OTA install,
  launch, rollback, status reporting, rollout rules, or runtime UI.
- If the local worktree is dirty, keep it out of the scenario unless the caller
  explicitly wants to include those changes. The PR diff target is
  `merge-base(base, HEAD)..HEAD`, not the unstaged local worktree.
- Keep the scenario tight to the changed behavior. Do not default to the full
  fixed regression in `../e2e-auto` unless the diff truly spans both stable and
  recovery flows.

## Script

`scripts/summarize_pr_diff.py` prints:

- current branch and PR metadata
- detected base branch, resolved git ref, and merge base
- diffstat
- changed files with area and risk tags
- likely scenario hints
- truncated patch excerpts for quick triage
- local worktree differences so PR diff and unstaged changes do not get mixed

Useful commands:

```bash
./.agents/skills/e2e-current-pr/scripts/summarize_pr_diff.py
./.agents/skills/e2e-current-pr/scripts/summarize_pr_diff.py --base chore/0.29.0
./.agents/skills/e2e-current-pr/scripts/summarize_pr_diff.py --json
```

## Report

Include:

- base branch and merge base used
- changed OTA surfaces
- scenario chosen and why
- platforms run and why
- deployed bundle ids and final status evidence from `../e2e`
- any areas intentionally left uncovered
