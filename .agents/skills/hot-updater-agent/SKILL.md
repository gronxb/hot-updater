---
name: hot-updater-agent
description: Use when an AI agent needs to run or inspect full HotUpdater E2E jobs, or prepare and lease a profile-scoped manual QA environment through the local `hot-updater-agent` CLI.
---

# HotUpdater Agent

Use this skill from the HotUpdater repository root when E2E should run through
the dashboard queue or manual QA needs prepared provider infrastructure.

The CLI infers the current PR with `gh pr view`; there is no `-pr` flag.

## Profiles

Valid profiles:

- `standalone-dynamodb`
- `standalone-drizzle`
- `standalone-prisma`
- `standalone-kysely`
- `standalone-mongodb`
- `supabase`
- `cloudflare`
- `firebase`
- `aws`

Use the user-mentioned profile. If none is mentioned, use
`standalone-kysely`.

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

Prepare one platform for agent-device-led manual QA:

```bash
hot-updater-agent manual start <profile> \
  -platform <ios|android> \
  -ref "$(git rev-parse HEAD)" \
  -env-target examples/v0.85.0/.env.hotupdater \
  -ttl 2h
```

`manual start` waits until the profile service, native release artifact, and
control server are ready. Human output returns all handoff fields and exact
agent-device commands. Prefer structured output when another agent consumes
the handoff:

```bash
hot-updater-agent -json manual start <profile> -platform ios -ref "$(git rev-parse HEAD)"
```

The JSON session contains `id`, status/expiry/ref/log metadata, and
`handoff.worktreePath`, `scenarioRoot`, `envTargetPath`, `controlBaseUrl`,
`runtimeConfigUrl`, `appBaseUrl`, `cleanupCommand`, plus
`handoff.agentDevice` with session, platform, device ID, app ID, binary path,
and exact boot/install/open/snapshot/close commands.

Inspect or release the lease:

```bash
hot-updater-agent manual status [session-id] [-limit 20]
hot-updater-agent manual stop <session-id>
hot-updater-agent manual --help
```

Only one manual session may be active. It blocks dashboard E2E execution until
`manual stop` or TTL expiry. Always stop it in a finally-style cleanup path;
iOS and Android manual sessions must run sequentially.

## Workflow

1. Choose full E2E (`verify`) or prepared manual QA (`manual start`).
2. Check existing work: `hot-updater-agent status -limit 5` and, for manual
   work, `hot-updater-agent manual status -limit 5`.
3. For provider diagnosis, read
   `hot-updater-agent -json timeline <profile> -limit 10`.
4. For a failed exact E2E job, read
   `hot-updater-agent reason <task-id> -tail 240`.
5. For manual QA, consume only the returned handoff and always stop the lease.
6. Re-run the same path until it succeeds or the blocker is clearly outside
   repository code.

Use `timeline` data to distinguish setup, deploy, service boot, app reload, and
E2E command execution bottlenecks. Compare `providerBottlenecks[*].totalMs`,
`providerBottlenecks[*].slowestStage`, and global `bottlenecks`.

## Default suite contract

Full-platform `verify` reads
`e2e/detox/default-scenario-names.json` from the exact checked-out PR commit.
Adding a scenario to that manifest automatically includes it in every
full-platform verification profile. A missing, empty, malformed, or duplicate
manifest is a verification failure; do not replace it with an agent-side
fallback list.
