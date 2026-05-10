---
name: hot-updater-agent
description: Use when an AI agent needs to queue, monitor, diagnose, and iterate on HotUpdater E2E dashboard jobs through the Mac mini `hot-updater-agent` CLI instead of running local device flows directly. Trigger for requests to run PR E2E through the dashboard, inspect queued E2E failures, tail bot logs, or fix-and-rerun E2E until green.
---

# HotUpdater Agent

Use this skill from the HotUpdater repository root when the E2E should run through
the Mac mini dashboard queue rather than directly through local `pnpm` or
`agent-device` commands.

The CLI is installed on the Mac mini as:

```bash
hot-updater-agent
```

It talks to the local dashboard API at `http://127.0.0.1:3131` and reads the bot
token from `~/.hot-updater-e2e-bot/secrets/legacy-api-token.txt`.

The CLI always infers the PR number from the current git branch with
`gh pr view --json number -q .number`. There is no `-pr` flag.

## Primary Goal

Use `hot-updater-agent` as the E2E verification control loop for AI:

1. Run `verify` for the common queue-wait-reason flow.
2. Use `e2e`, `status`, `wait`, and `reason` separately when the task id needs
   to be handled step by step.
3. Print the failure reason by task id.
4. Diagnose the likely repo cause.
5. Patch this repo.
6. Re-run the same queued E2E command.
7. Repeat until the dashboard job succeeds or the blocker is outside repo code.

The agent should keep iterating autonomously when the user asks for E2E
verification or an E2E fix loop. Stop only when the task is green, the failure is
clearly infrastructure-only, or there is no meaningful repo-side fix left.

## Profile Selection

The user may mention one of these E2E profiles:

- `standalone`
- `supabase`
- `cloudflare`
- `firebase`
- `aws`

Use the mentioned profile as `-profile <profile>`. If the user does not mention
one of these profiles, default to `standalone`.

## Required CLI Surface

Queue a task from the current PR branch:

```bash
hot-updater-agent e2e -platform <full|ios|android> -profile <profile> -env-target <path>
```

Queue a task from the current PR branch, wait for it, and print the failure reason if it fails:

```bash
hot-updater-agent verify -platform <full|ios|android> -profile <profile> -env-target <path>
```

Check the current branch PR queue:

```bash
hot-updater-agent status -limit 5
```

Wait for a task id to finish:

```bash
hot-updater-agent wait <task-id> -tail 240
```

Print the failure reason for a task id:

```bash
hot-updater-agent reason <task-id> -tail 240
```

Read the raw log tail for a task id:

```bash
hot-updater-agent log <task-id> -tail 240
```

## Queue E2E

Default full-platform dashboard run for PR `911`:

```bash
hot-updater-agent verify \
  -platform full \
  -profile standalone \
  -env-target examples/v0.85.0/.env.hotupdater
```

Run one platform only:

```bash
hot-updater-agent verify -platform ios -profile standalone -env-target examples/v0.85.0/.env.hotupdater
hot-updater-agent verify -platform android -profile standalone -env-target examples/v0.85.0/.env.hotupdater
```

Use `verify` for the normal AI loop. It queues E2E, prints the task id, waits on
that task id, and prints the failure summary if the job fails. Use `e2e` when
you only want to enqueue and handle the task id manually.

## Inspect Jobs

List recent jobs for a PR:

```bash
hot-updater-agent status
```

List the latest job only:

```bash
hot-updater-agent status -limit 1
```

Get machine-readable output:

```bash
hot-updater-agent -json status -limit 5
```

## Diagnose Failure

Print job metadata and log tail:

```bash
hot-updater-agent log <job-id> -tail 240
```

Print a failure summary for a completed failed task:

```bash
hot-updater-agent reason <task-id> -tail 240
```

For running jobs, `wait` polls until terminal status. For already failed jobs,
`wait` immediately prints the failure summary and exits non-zero. `reason` is
the explicit diagnostic command: it prints the failure summary for a terminal
failed task and exits successfully so the AI can read and act on the output.

## Iteration Rules

- Start with `hot-updater-agent status -limit 3` if a task may already exist for
  the current branch PR.
- If there is a recent failed task, inspect it with `reason <task-id>` before
  enqueueing another run.
- After queueing, record the printed task id. All later wait/log/reason commands
  must use that exact id.
- Treat the failure summary as triage. Open referenced source files and logs
  before patching.
- Keep patches small and focused on the observed failure.
- Re-run the exact same E2E command after each plausible fix.
- If logs show an infrastructure/device issue such as simulator driver
  connectivity, report that separately from repo-code failures.
- Do not run iOS and Android local direct flows in parallel with a queued
  dashboard run unless the user explicitly asks.

## AI Infinite Loop Template

Use this pattern when asked to fix E2E through the dashboard:

```bash
hot-updater-agent status -limit 3
hot-updater-agent verify -platform full -profile standalone -env-target examples/v0.85.0/.env.hotupdater -tail 240
```

Then patch the repo, run the smallest relevant local check, and repeat `verify`
until success.

## Common Failure Signal

If the failure contains XCUITest driver connection errors such as:

```text
Failed to connect to /127.0.0.1:7001
```

classify it first as an iOS simulator/Maestro infrastructure issue, then inspect
nearby app/server log lines to make sure it is not caused by repo code.
