# Mobile E2E runner

The runner uses `e2e@0.16.0`, `@e2e-dev/mobile@0.9.1`, and
`agent-device@0.21.18` to execute the 27 scenarios in
[`../scenario-names.json`](../scenario-names.json). The shared control server
prepares OTA fixtures and verifies native recovery and Console Insights.
No model or agent prompts are used.

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

Runs require exclusive access to their devices and provider profiles. The
upstream agent-device daemon is shared within an OS user, so parallel bot/device
jobs must use a dedicated host or OS user. Worktrees and session names alone do
not isolate daemon recovery. The local runner leases its prepared profile and
refuses overlapping ownership.

Checks without devices:

```sh
pnpm -w e2e:test:type
pnpm exec vitest run --project=unit:e2e
```
