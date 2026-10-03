# Mobile E2E runner

The runner uses `e2e@0.16.0`, `@e2e-dev/mobile@0.9.1`, and
`agent-device@0.21.18` to execute the 27 scenarios in
[`../scenario-names.json`](../scenario-names.json). The shared control server
prepares OTA fixtures and verifies native recovery and Console Insights.
No model or agent prompts are used. iOS app-opening confirmation dialogs are
recognized in English and Korean; other locales or unrelated prompts fail
without accepting the dialog.

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
be repeated; `--suite default` selects all 27. `--dry-run` prints the selection
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

The daemon uses the internal launcher shipped with agent-device 0.21.18, matching
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
