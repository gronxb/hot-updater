# Mobile E2E runner

The runner uses `e2e@0.18.0`, `@e2e-dev/mobile@0.10.0`, and
`agent-device@0.21.22` to execute the 30 scenarios in
[`../scenario-names.json`](../scenario-names.json). The shared control server
prepares OTA fixtures and verifies native recovery and Console Insights.
iOS app-opening confirmation dialogs are recognized in English and Korean;
other locales or unrelated prompts fail without accepting the dialog.

## How the suite uses e2e

The suite is deterministic: it declares no `agents` and no model, the replay
cache is off, and `result.ts` rejects a report that spent model tokens. Never
add `agent.*` steps.

- [`e2e.config.ts`](e2e.config.ts) declares one `mobile()` target per run. The
  target's `app` pins the bundle ID, the Release build (`appPath`), and the
  runtime URLs as `launchArguments`, which ride every relaunch of the pinned
  app.
- [`scenarios.e2e.ts`](scenarios.e2e.ts) registers one test per selected
  scenario. A `hotUpdater` fixture (`test.extend`) owns each attempt's control
  client and abort signal. `beforeEach` installs the build once per device,
  then bootstraps and resets the fixtures; `afterEach` drains control jobs,
  stops the app, and records cleanup and Console Insights evidence, after a
  failure too.
- [`driver.ts`](driver.ts) runs the shared scenario steps with `screen`
  locators, `device.openApp` and `device.openLink`, and `expect` matchers:
  `toBeVisible`, `toHaveText` for exact results, and `toContainText` for
  alternatives. Text compares as the SDK normalizes it, trimmed with runs of
  whitespace collapsed. Nothing sleeps or polls by hand: an iOS route that may
  ask to open the app waits with `expect.poll`.
- The one direct agent-device call is [`ios-alert.ts`](ios-alert.ts). It reads
  the iOS system alert's title and buttons, which `device.alert()` cannot
  report, so the driver accepts only the expected app-open dialog.

`HOT_UPDATER_E2E_TEST_TIMEOUT_MS` sets the SDK `timeout` of one scenario
attempt, bootstrap and reset included (default one hour). Each run writes the
SDK's `report.json`, `summary.md`, and one Markdown page per failed scenario to
`e2e/results/mobile/<id>/runner/`, with failure screenshots and screen dumps
under its `artifacts/`.

Agents editing this suite should load the [`e2e` skill](../../.agents/skills/e2e/SKILL.md).
It tracks the latest e2e release; `pnpm exec e2e guide <topic>` prints the guide
for the pinned version.

## Running

Use the canonical [`pnpm -w e2e`](../README.md) command for local setup and
execution. Prepared mode runs against an existing provider profile and an
explicitly leased simulator or emulator:

```sh
pnpm -w e2e:build -- --platform ios
pnpm -w e2e -- --prepared --platform ios --device <simulator-UDID>
pnpm -w e2e:build -- --platform android
pnpm -w e2e -- --prepared --platform android --device <emulator-serial>
```

`--list` lists the shared scenarios. `--scenario <name>` selects one and can
be repeated; `--suite default` selects all 30. `--dry-run` prints the selection
without accessing a device. Existing `HOT_UPDATER_E2E_SCENARIOS` comma-separated
selection and binary-path overrides are supported. `e2e:build --dry-run` prints
native build commands without building or discovering devices.

The bot supplies `--run-id`, `--head-sha`, `--profile`, `--session`, and
`--results-dir` in prepared mode. The wrapper verifies the checkout SHA, fixes
one worker and zero retries, and writes `hot-updater-result.json` after teardown.
An exit code of zero alone is insufficient: canonical SDK results, matching run
identity, UI/scenario and Console Insights evidence, and independent cleanup
proof must all agree. Successful reports are retained alongside failure reports.

Each run owns its control server and output directory. External control URLs
are rejected. Android reverse mappings are acquired on the selected serial;
conflicting mappings fail before bootstrap, and only owned mappings are removed.
Cancellation aborts the attempt and drains accepted control jobs before final
fixture cleanup. Uncertain remote completion produces `quarantine.json` and a
failed result; the bot blocks conflicting resources pending operator inspection.

Each run also starts its own pinned agent-device daemon in a private temporary
state directory, verifies its PID/start time, version and HTTP protocol, and
connects the SDK through authenticated loopback HTTP. Inherited agent-device
configuration is replaced with this owned transport; its token is never written
to result artifacts. HTTP transport avoids upstream local-client recovery that
can affect a different daemon. Shared exact-device ownership claims remain in
their normal location, so runs still require exclusive devices and provider
profiles. The local runner leases its prepared profile and refuses overlapping
ownership.

The daemon uses the internal launcher shipped with agent-device 0.21.22, matching
the entry used by that version's own SDK. This pinned compatibility contract is
covered by a startup/health/shutdown test and must be revalidated when upgrading.
Startup refuses legacy shared XCTestDevices symlinks/backups that upstream would
otherwise migrate. Apple runner detachment is disabled. Teardown invokes the
pinned public `daemon stop --state-dir <owned> --clean --json` command, verifies
its cleanup report, and only falls back to stopping its own process group.
Unverified or forced cleanup fails the run and preserves private state for
reconciliation. No global daemon stop or global process-name cleanup is used.

Checks without devices:

```sh
pnpm -w e2e:test:type
pnpm exec vitest run --project=unit:e2e
```
