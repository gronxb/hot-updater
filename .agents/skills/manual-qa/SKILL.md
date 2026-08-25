---
name: manual-qa
description: Manually execute one named `examples/v0.85.0` OTA scenario with a profile-scoped environment prepared by `hot-updater-agent` and app interactions driven through `agent-device`. Use when the caller supplies a scenario name and wants AI-led manual QA instead of the full Detox E2E runner.
---

# Hot Updater Manual QA

The only required caller input is a scenario name, for example
`release-ota-recovery` or `release-ota-recovery.ts`.

Always load and follow
[$hot-updater-agent](../hot-updater-agent/SKILL.md) and
[$agent-device](../agent-device/SKILL.md), then read
[references/runtime-targets.md](references/runtime-targets.md).

## Defaults

- Profile: `standalone-dynamodb`.
- Platforms: iOS, then Android, strictly sequential.
- Environment target: `examples/v0.85.0/.env.hotupdater`.
- Git target: the exact current `HEAD` SHA.
- Lease: two hours.

Honor explicit profile, platform, ref, environment target, or lease overrides.
Never ask for them when the defaults are sufficient.

## Start The Prepared Environment

For each platform, run from the repository root:

```bash
hot-updater-agent -json manual start standalone-dynamodb \
  -platform ios \
  -ref "$(git rev-parse HEAD)" \
  -env-target examples/v0.85.0/.env.hotupdater \
  -ttl 2h
```

The command waits for readiness. Treat the returned JSON handoff as the only
source of truth. It includes:

- session ID, status, expiry, resolved ref, and log path;
- retained worktree, scenario root, and injected env target;
- control, runtime-config, and update-server URLs;
- platform, device ID, app ID, release artifact path, and agent-device session;
- exact `boot`, `install`, `open`, `snapshot`, and `close` commands;
- the cleanup command in human-readable output.

Do not reconstruct fixed ports, paths, app IDs, devices, or agent-device flags.
Use the values and commands returned for this session.

## Resolve The Scenario

Normalize only an optional `.ts` suffix. Reject directory components and
resolve exactly:

```text
<handoff.scenarioRoot>/<scenario-name>.ts
```

Stop if that file does not exist. Read the complete scenario and
`<handoff.scenarioRoot>/types.ts`, then read the complete
`<handoff.scenarioRoot>/../detox-app-driver.js`. The scenario is the executable
specification and the driver defines the orchestration semantics that must be
translated from Detox to control calls plus agent-device. Preserve call order,
request bodies, saved result variables, exact text expectations,
launch/reload boundaries, screen-state waits, Android reattachment, and
negative assertions. Do not run Detox and do not substitute a similarly named
scenario.

## Translate The Scenario Manually

Interpret the scenario driver operations as follows:

- `app.control(stage, path, body)`: POST JSON to
  `<handoff.controlBaseUrl><path>`. If the response contains `jobId`, poll
  `GET /e2e/jobs/<jobId>` until `succeeded`; fail on `failed` or `cancelled`.
  Save every returned field, apply `saveResultAs`/`saveResultFieldsAs` aliases
  exactly like `detox-app-driver.js`, then interpolate later `$variable`
  references. Reattach Android after external relaunch/recovery endpoints when
  the driver does.
- `app.launch(...)`: POST `/e2e/prepare-app-launch`, then run the returned
  `openCommand`. Preserve `allowDisconnect` semantics for intentional crash
  launches.
- `app.reload(...)`: run `closeCommand`, POST `/e2e/prepare-app-launch`, then
  run `openCommand`.
- `app.terminate(...)`: run the returned `closeCommand`.
- `app.resetAppState(...)`: POST `/e2e/reset-local-app-state`, then run the
  returned `openCommand`.
- `app.tap(..., testID)`: follow the action-result mapping in
  `detox-app-driver.js`. Reset the mapped `/e2e/screen-state` field to `idle`,
  open the focused route for that testID, take a fresh returned
  `snapshotCommand`, press the exact element with `--settle`, and wait through
  `runtimeConfigUrl` until the result is neither `idle` nor ` -> checking`.
- `app.typeText(...)`: open and snapshot the focused route, fill the exact
  testID with `--settle`, then mirror the driver's `/e2e/screen-state` patch
  for mapped text inputs.
- `app.assertText(..., testID, expected)`: open the focused evidence route,
  take a fresh interactive snapshot, and assert the current text with
  agent-device `get`, `is`, `find`, or `wait`. For action-result `exactText`,
  first wait for the matching runtime-config screen-state field exactly as the
  driver does. Honor `exactText`; for arrays, any listed value may satisfy the
  assertion.

Before the first scenario step, run the returned `bootCommand`,
`installCommand`, and `openCommand` in that order.

Use `curl -fsS` with `content-type: application/json` for control calls. Keep a
small variable ledger containing every saved Bundle ID, Release ID, authority,
scope, generation, cohort, and marker. Never continue with an empty or guessed
saved value.

## OTA Assertion Rules

- Release IDs prove selection and policy; Bundle IDs prove bytes, patches,
  manifests, storage, and crash history.
- Public launch statuses are exactly `UNCHANGED | UPDATE_APPLIED | RECOVERED`.
  Directional identity is `fromReleaseId`, `fromBundleId`, `toReleaseId`, and
  `toBundleId`.
- `notifyAppReady` is read-only and must not affect crash detection or receipt
  promotion.
- Crash bundles must throw at module scope. Never convert crash steps into UI
  crashes.
- Deploy only through the control server/`pnpm hot-updater deploy`; never seed
  Bundle or Release database rows directly.
- Use release artifacts only. Never start Metro or install a debug build.
- Use interactive snapshots for structural evidence; take screenshots only
  when asked.

## Cleanup

Always clean up in a `finally`-style path, including assertion failure or user
interruption:

1. Run the returned `closeCommand` if the app/session was opened.
2. Run `hot-updater-agent manual stop <session-id>`.
3. Confirm `hot-updater-agent manual status <session-id>` is `stopped` (or
   `expired` if the lease elapsed).

Do not start Android until the iOS session has stopped. A manual session owns
an exclusive dashboard E2E lease, so leaving it ready blocks queued E2E work.

## Reporting

Report scenario, profile, platform, prepared commit, session ID, deployed
Release/Bundle pairs, saved runtime variables, each assertion and evidence
source, final status, and cleanup result. On failure include the failing stage,
control response or snapshot evidence, and the session log path.
