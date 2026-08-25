---
name: manual-qa
description: Execute a caller's natural-language HotUpdater QA scenario on `examples/v0.85.0` with profile-scoped infrastructure prepared by `hot-updater-agent` and app interactions driven through `agent-device`. Use for AI-led manual OTA QA rather than the full Detox E2E runner.
---

# Hot Updater Manual QA

The only required caller input is a natural-language scenario. Accept the
user's intent directly; never require or reinterpret it as a file name from
`e2e/detox/scenarios`.

Always load and follow
[$hot-updater-agent](../hot-updater-agent/SKILL.md) and
[$agent-device](../agent-device/SKILL.md), then read
[references/runtime-targets.md](references/runtime-targets.md).

## Defaults

- Profile: `standalone-kysely`.
- Platforms: iOS, then Android, strictly sequential.
- Environment target: `examples/v0.85.0/.env.hotupdater`.
- Git target: the exact current `HEAD` SHA.
- Lease: two hours.

Honor explicit profile, platform, ref, environment target, or lease overrides.
Never ask for them when the defaults are sufficient.

## Start The Prepared Environment

For each platform, run from the repository root:

```bash
hot-updater-agent -json manual start standalone-kysely \
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
- the exact cleanup command.

Do not reconstruct fixed ports, paths, app IDs, devices, or agent-device flags.
Use the values and commands returned for this session.

## Turn Natural Language Into A Manual Plan

Before touching the device, translate the request into a small observable test
plan containing:

- required preconditions and OTA/provider state;
- user-visible actions in order;
- expected results and the evidence that will prove each result;
- any destructive or intentionally crashing step that needs special handling.

Keep the user's scope. Do not silently expand a focused request into the fixed
regression suite. If a required expectation is genuinely ambiguous after
inspecting the app and control contracts, stop and name the ambiguity instead
of inventing a pass condition.

Use the prepared worktree to discover how to carry out the plan. Read only the
relevant parts of:

- `examples/v0.85.0/src/e2eApp` for routes, actions, testIDs, and visible
  evidence;
- `e2e/detox/control-server/routes.ts` for supported control operations;
- `e2e/detox/detox-app-driver.js` when launch, reload, screen-state wait, crash,
  or Android reattachment semantics matter;
- `e2e/detox/scenarios` only as optional implementation examples for a similar
  step, never as the accepted input vocabulary or an exact script to run.

Do not create a Detox scenario file and do not run Detox.

## Execute With Control APIs And Agent Device

- Before the first app step, run the returned `bootCommand`, `installCommand`,
  and `openCommand` in that order.
- Use the returned agent-device session/device binding for every app command.
  Open the focused route for the intended action or evidence, take an
  interactive snapshot, then use refs/selectors with `--settle` for mutations.
- Verify named expectations with agent-device `wait`, `get`, `is`, `find`, or
  settled diffs. A screenshot or bare snapshot alone is not a pass condition.
- POST infrastructure/deploy/state operations to
  `<handoff.controlBaseUrl><path>`. For responses containing `jobId`, poll
  `GET /e2e/jobs/<jobId>` until `succeeded`; fail on `failed` or `cancelled`.
- Record every returned Bundle ID, Release ID, authority, scope, generation,
  cohort, marker, and other value needed by a later assertion. Never continue
  with an empty or guessed value.
- Before a fresh launch, POST `/e2e/prepare-app-launch`; for reload, close the
  app, prepare the launch, then reopen it. Use
  `/e2e/reset-local-app-state` only when the user's precondition requires a
  clean local state.
- For mapped action results, mirror `detox-app-driver.js`: reset the relevant
  `/e2e/screen-state` field to `idle`, perform the UI action, and wait through
  `runtimeConfigUrl` until the field reaches the expected value. Reattach
  Android after external restart or crash-recovery operations when required.
- Preserve intentional crash/disconnect semantics and gather recovery evidence
  after relaunch; do not convert a module-scope crash case into an unrelated UI
  crash.

Use `curl -fsS` with `content-type: application/json` for control calls. Keep a
small evidence ledger that links each expected result to the observed UI,
control response, or native state.

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

Report the user's scenario, resolved manual plan, profile, platform, prepared
commit, session ID, deployed Release/Bundle pairs, saved runtime variables,
each assertion and evidence source, final status, and cleanup result. On
failure include the failing stage, control response or snapshot evidence, and
the session log path.
