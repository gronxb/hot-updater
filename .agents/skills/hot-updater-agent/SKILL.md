---
name: hot-updater-agent
description: Use when an AI agent needs to run, monitor, diagnose, or iterate HotUpdater E2E jobs through the local `hot-updater-agent` dashboard CLI instead of running device flows directly.
---

# HotUpdater Agent

Use this skill from the HotUpdater repository root when E2E should run through
the dashboard queue.

The CLI infers the current PR with `gh pr view`; there is no `-pr` flag.

## Profiles

Valid profiles:

- `standalone-s3`
- `standalone-drizzle`
- `standalone-prisma`
- `supabase`
- `cloudflare`
- `firebase`
- `aws`

Use the user-mentioned profile. If none is mentioned, use `standalone-s3`.

## Commands

Queue and wait for the normal AI verification loop:

```bash
hot-updater-agent verify -platform <full|ios|android> -profile <profile> -env-target examples/v0.85.0/.env.hotupdater
```

Queue without waiting:

```bash
hot-updater-agent e2e -platform <full|ios|android> -profile <profile> -env-target examples/v0.85.0/.env.hotupdater
```

Inspect current PR jobs:

```bash
hot-updater-agent status -limit 5
```

Inspect recent successful baselines by profile:

```bash
hot-updater-agent status -latest-success-by-profile -limit 20
hot-updater-agent -json status -latest-success-by-profile -limit 20
```

Inspect an exact job:

```bash
hot-updater-agent wait <task-id> -tail 240
hot-updater-agent reason <task-id> -tail 240
hot-updater-agent log <task-id> -tail 240
```

Inspect provider and stage bottlenecks. Prefer profile lookup for provider
diagnosis because it resolves to the latest successful job for that profile:

```bash
hot-updater-agent timeline <profile|task-id> -limit 10
hot-updater-agent -json timeline <profile|task-id> -limit 10
```

## Workflow

1. Check existing work: `hot-updater-agent status -limit 5`.
2. For performance or provider diagnosis, read `hot-updater-agent -json timeline <profile> -limit 10`.
3. For a failed exact job, read `hot-updater-agent reason <task-id> -tail 240`.
4. Patch this repo based on the observed failure.
5. Re-run the same `verify` command until the dashboard job succeeds or the blocker is clearly outside repo code.

Use `timeline` data to distinguish setup, deploy, service boot, app reload, and
E2E command execution bottlenecks. Compare `providerBottlenecks[*].totalMs`,
`providerBottlenecks[*].slowestStage`, and global `bottlenecks`.
