# Release device E2E evidence

## Automated full-profile runs

Test revision: `0e821f7fa8f365a7446c2ab41fbe92ee852ddb4e`.

| Profile | Job | iOS shard 1 | iOS shard 2 | Android | Result |
| --- | --- | ---: | ---: | ---: | --- |
| `standalone-prisma` | `job-20260921005127-t6et2u` | 15/15 | 11/11 | 26/26 | PASS |
| `standalone-kysely` | `job-20260921005128-ikedco` | 15/15 | 11/11 | 26/26 | PASS |
| `standalone-mongodb` | `job-20260921005130-0se7j0` | 15/15 | 11/11 | 26/26 | PASS |
| `standalone-dynamodb` | `job-20260921010855-0oxca7` | 15/15 | 11/11 | 26/26 | PASS |
| `standalone-drizzle` | `job-20260921010857-55tk1y` | 15/15 | 11/11 | 26/26 | PASS |

All five runs used the exact revision above and passed the complete Release
suite on both platforms. In particular,
`fingerprint-initial-install` and
`bspatch-builtin-to-diff-ota` passed on iOS and Android, proving the refreshed
native fingerprint fixtures and builtin-to-manifest OTA path on real packaged
artifacts.

## Focused manual run

Test revision: `38d46c05df90e4f4c93e079d4aedacac9de0a111`.

## iOS simulator

- Date: 2026-09-20
- Profile: `standalone-kysely`
- Manual session: `manual-20260920093231-2rnqkz`
- Device: iPhone 16 simulator,
  `0368C5D9-63CF-447E-B6BB-0E3184B1CD0A`
- Configuration: `ios.sim.release`
- Scenario: `bspatch-builtin-to-diff-ota`
- Result: PASS, 78.747 seconds for the scenario; 1 test passed and 25 were
  intentionally filtered.

The scenario proved all of the following through the control boundary and
native bundle store:

- The first OTA request used the builtin manifest identity.
- The builtin base installed and survived a stable relaunch.
- The server generated the expected builtin diff base.
- The next update applied a real bsdiff patch for `index.ios.bundle`.
- The target Bundle ID and marker were visible after reload and remained
  stable on another launch.
- Console events reported downloaded and applied outcomes for the target.

Relevant measured stages were 1.010 seconds waiting for the first install
action result and 1.008 seconds waiting for the patched install action result.
These are one-run E2E observations, not latency benchmarks.

## Android emulator

The automated full-profile runs above include the Android Release emulator.
