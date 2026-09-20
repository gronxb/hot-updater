# Release device E2E evidence

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

Pending while another repository E2E job holds the shared device lease.
