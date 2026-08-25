---
name: e2e-current-pr
description: Select an existing PR-aware OTA scenario for `examples/v0.85.0` by diffing the checked-out branch against its PR base/default branch, then execute it through `../manual-qa`. Use when the caller wants current-branch manual OTA validation without choosing the scenario.
---

# E2E Current PR

Use this skill from the repository root on the branch that should be validated.

Always load and follow [$manual-qa](../manual-qa/SKILL.md). This skill owns
base-branch detection, diff review, existing scenario selection, and platform
choice. `../manual-qa` owns infrastructure preparation, control calls,
agent-device interaction, evidence gathering, and cleanup.

## Workflow

1. Run `./.agents/skills/e2e-current-pr/scripts/summarize_pr_diff.py`.
2. If the caller gave an explicit base branch, pass `--base <branch>`. Otherwise
   let the script detect the base from `gh pr view` and fall back to the repo
   default branch.
3. Read the summary, then inspect the changed files that look OTA-relevant. Do
   not rely on the tags alone if the patch excerpt points at risky runtime code.
4. Map the risk to the narrowest existing file under `e2e/detox/scenarios`.
   State the base branch, changed risk areas, chosen platform scope, and why the
   selected scenario covers them. Then pass only that scenario name plus any
   required platform override to [$manual-qa](../manual-qa/SKILL.md).
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
- Add catalog/local-selection races when the diff touches Release compilation,
  authority/scope URLs, high-water/context CAS, rollout, cohorts, or artifact
  resolution. Use proxy capture/freeze/replay/delay and assert stale catalog or
  artifact completions cannot commit.
- Add a same-Bundle adoption phase when a management change can create a new
  Release over existing Bundle bytes. Assert the Release receipt changes with
  zero artifact requests and no reload.
- Prefer iOS first when the diff is iOS-only. Prefer Android first when the
  diff is Android-only. Run both platforms when shared packages, deploy logic,
  or cross-platform example code changes.
- If the diff only changes docs, CI, or tooling with no OTA runtime impact,
  stop and explain that this skill does not have a meaningful E2E scenario to
  run.
- If no existing scenario meaningfully covers the changed behavior, stop and
  report the missing coverage. Do not invent or edit a scenario during this
  skill run.

## Diff Review Rules

- Treat the script output as triage, not as the final verdict.
- Read the actual patch for every changed file that could affect OTA install,
  launch, rollback, status reporting, rollout rules, or runtime UI.
- If the local worktree is dirty, keep it out of the scenario unless the caller
  explicitly wants to include those changes. The PR diff target is
  `merge-base(base, HEAD)..HEAD`, not the unstaged local worktree.
- Keep the scenario tight to the changed behavior. Do not default to the full
  fixed regression in `../e2e-default` unless the diff truly spans both stable
  and recovery flows.
- Treat Release policy and Bundle artifacts as separate risk surfaces. Policy
  changes use `/e2e/jobs/patch-release` and Release IDs; patch/manifest/storage
  assertions keep Bundle IDs.

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
- manual session IDs, deployed Release/Bundle pairs, final
  receipt/high-water, public status evidence, and cleanup results from
  `../manual-qa`
- any areas intentionally left uncovered
