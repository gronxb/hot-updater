# Mobile E2E runner

The optional `mobile` runner uses `e2e@0.16.0` and `@e2e-dev/mobile@0.9.1`
with `agent-device@0.21.18`. It runs the same scenario manifest and control
server as Detox. Detox remains available and remains the bot default.
No model or agent prompts are used.

Use Node 24 and the repository's pinned pnpm version. Build an ordinary
Release app, then run against an explicitly leased simulator or emulator:

```sh
pnpm -w e2e:build -- --platform ios
pnpm -w e2e:mobile -- --platform ios --device <simulator-UDID>
pnpm -w e2e:build -- --platform android
pnpm -w e2e:mobile -- --platform android --device <emulator-serial>
```

`--list` lists the shared scenarios. `--scenario <name>` selects one and can
be repeated; `--suite default` selects all 27. `--dry-run` prints the selection
without accessing a device. Existing `HOT_UPDATER_E2E_SCENARIOS` comma-separated
selection and binary-path overrides are supported. `e2e:build --dry-run` prints
native build commands without building or discovering devices.

The bot supplies `--run-id`, `--head-sha`, `--profile`, `--session`, and
`--results-dir`. The wrapper verifies the checkout SHA, fixes one worker and
zero retries, and writes `hot-updater-result.json` after teardown. An exit code
of zero alone is insufficient: canonical SDK results, matching run identity,
UI/scenario and Console Insights evidence, and independent cleanup proof must
all agree. Successful reports are retained alongside failure reports.

Each run owns its control server and output directory. External control URLs
are rejected. Android reverse mappings are acquired on the selected serial;
conflicting mappings fail before bootstrap, and only owned mappings are removed.
Cancellation aborts the attempt and drains accepted control jobs before final
fixture cleanup. Uncertain remote completion produces `quarantine.json` and a
failed result; the bot blocks conflicting resources pending operator inspection.

Run mobile qualification on a dedicated host or OS user with exclusive devices
and provider profiles. The upstream agent-device daemon is shared within an OS
user; a unique session or worktree alone does not isolate daemon recovery from
other device jobs. Do not enable this runner alongside the active production
bot's device sessions until that operational isolation is provided. Native
device parity and provider qualification are required before changing defaults
or removing Detox.

Local checks without devices:

```sh
pnpm -w e2e:test:type
pnpm exec vitest run --project=unit:e2e
```
