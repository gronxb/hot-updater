# hot-updater

## 0.31.1

### Patch Changes

- 8eb21d7: Check native OTA wiring in doctor
  - @hot-updater/android-helper@0.31.1
  - @hot-updater/apple-helper@0.31.1
  - @hot-updater/cli-tools@0.31.1
  - @hot-updater/console@0.31.1
  - @hot-updater/core@0.31.1
  - @hot-updater/server@0.31.1
  - @hot-updater/plugin-core@0.31.1

## 0.31.0

### Minor Changes

- 5b0a0f5: Add signed manifest-based diff update support across deploy, server, provider storage, console tooling, and React Native runtime.

### Patch Changes

- 5b0a0f5: Add CLI bundle inspection and metadata mutation commands for automation:
  `bundle show`, `bundle update`, and `bundle delete`.
- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/console@0.31.0
  - @hot-updater/server@0.31.0
  - @hot-updater/android-helper@0.31.0
  - @hot-updater/cli-tools@0.31.0
  - @hot-updater/plugin-core@0.31.0
  - @hot-updater/apple-helper@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/android-helper@0.30.12
- @hot-updater/apple-helper@0.30.12
- @hot-updater/cli-tools@0.30.12
- @hot-updater/console@0.30.12
- @hot-updater/core@0.30.12
- @hot-updater/server@0.30.12
- @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- eb32048: fix(cli): `deploy` falls back to the auto-detected target app version in non-interactive mode

  Previously, running `hot-updater deploy` without `-t` and without `-i` errored with
  "Target app version not found", even though `getDefaultTargetAppVersion` had already
  extracted the version from the binary's native files (Info.plist for iOS, build.gradle
  for Android) for use as the interactive prompt's placeholder. CI deploys had to
  either pass `-t` explicitly or scrape the version out of package.json.

  Now the resolution order is: explicit `-t` → interactive prompt (with the auto-detected
  value as placeholder) → auto-detected default → clear error if the native config is
  unreadable. Existing `-t` and `-i` invocations are unchanged.

  - @hot-updater/android-helper@0.30.11
  - @hot-updater/apple-helper@0.30.11
  - @hot-updater/cli-tools@0.30.11
  - @hot-updater/console@0.30.11
  - @hot-updater/core@0.30.11
  - @hot-updater/server@0.30.11
  - @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- 677271a: feat(cli): `deploy` runs both platforms when `-p` is omitted

  `hot-updater deploy` (without `-p ios` or `-p android`) now deploys ios then android sequentially. If ios fails, android is not attempted — the channel is never left half-updated. This is the typical CI/CD invocation pattern.

  ```
  hot-updater deploy -c dev               # ios + android, sequential, abort-on-first-failure
  hot-updater deploy -p ios -c dev        # unchanged: single platform
  hot-updater deploy -i -c dev            # unchanged: interactive prompt for one platform
  ```

  Existing `-p ios` / `-p android` invocations are unchanged; `-i` (interactive) still prompts for a single platform. The change is purely in the no-`-p`-no-`-i` path, which previously errored with "Platform not found" — that error path is now the multi-platform deploy.

- fb780c1: feat(cli): add `bundle promote` command

  Move or copy a bundle to a different channel from the CLI, mirroring the console's Promote-to-Channel UI.

  ```
  hot-updater bundle promote <bundle-id> -t <target-channel> [-a copy|move] [-y]
  ```

  - The bundle id is positional — the bundle carries its own source channel, so no `--source` flag is needed.
  - `--action copy` (default) creates a new bundle id on the target channel and leaves the original in place — CodePush-promote semantics.
  - `--action move` updates the bundle's `channel` column without creating a new bundle (D1-only mutation; no R2 work).
  - Wraps the `promoteBundle` function from `@hot-updater/cli-tools`, so the CLI and console use one implementation. Surfaces the underlying `LEGACY_BUNDLE_ERROR` and signing/storage configuration errors directly.

  Pre-flight: rejects bundle-already-on-target, missing bundle id, empty target. Refuses to mutate without `-y` in a non-TTY shell. Lives under the `bundle` namespace alongside `bundle list/disable/enable` since the noun being mutated is the bundle (its channel attribute, or a copy of it).

- 014430a: fix(cli): make multi-platform deploy a first-class flow

  `hot-updater deploy` now handles the no-`-p` path inside the deploy command
  itself instead of looping from the CLI entrypoint. This keeps the banner and
  success output consistent, makes it explicit that iOS and Android are deployed
  sequentially, and writes local bundle archives to platform-specific output
  directories so one platform no longer overwrites the other.

  - @hot-updater/android-helper@0.30.10
  - @hot-updater/apple-helper@0.30.10
  - @hot-updater/cli-tools@0.30.10
  - @hot-updater/console@0.30.10
  - @hot-updater/core@0.30.10
  - @hot-updater/server@0.30.10
  - @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/android-helper@0.30.9
- @hot-updater/apple-helper@0.30.9
- @hot-updater/cli-tools@0.30.9
- @hot-updater/console@0.30.9
- @hot-updater/core@0.30.9
- @hot-updater/server@0.30.9
- @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- 655b97c: feat(cli): add `bundle list/disable/enable` commands

  Adds three subcommands under a new top-level `bundle` namespace:

  - `hot-updater bundle list [-c <channel>] [-p <ios|android>] [--limit <n>]` — tabulated listing of bundles, most recent first. `--limit` validation uses commander's idiomatic `InvalidArgumentError` shape.
  - `hot-updater bundle disable <bundle-id> [-y]` — disable a single bundle. Refuses to mutate without `-y` in a non-TTY shell. Re-reads the bundle after `commitBundle` and exits non-zero if the change did not take effect; treats a mid-flight deletion as success.
  - `hot-updater bundle enable <bundle-id> [-y]` — re-enable a previously disabled bundle.

  All three commands load config via `loadConfig(null)` (matching the `console` command's idiom) since they are not platform-scoped operations. They use the existing `DatabasePlugin` interface (`getBundles`, `getBundleById`, `updateBundle`, `commitBundle`), so they work against every supported provider with no plugin-side changes. The `--platform` option is the shared `platformCommandOption` already used by `deploy`. `onUnmount` is wrapped in its own try/catch so cleanup errors never mask the originating mutation error. Help text documents the read-mutate-verify contract and exit codes (0 = success, 1 = error, 2 = user-aborted).

- 8318094: feat(cli): add `rollback <channel>` command

  Disables the most recent enabled bundle on a channel for each requested platform.

  ```
  hot-updater rollback <channel> [-p ios|android] [-y] [--confirm-revert-to-binary] [--target <bundle-id>]
  ```

  Behavior:

  - **Read phase** loads up to two most-recent enabled bundles per (channel, platform) so the operator can see what would become active after rollback.
  - **Validate phase** refuses with non-zero exit if any (channel, platform) would have **no** enabled bundles after the rollback unless `--confirm-revert-to-binary` is passed. The error message names both safe escape hatches in priority order: `-p <unaffected>` first, then `--confirm-revert-to-binary`.
  - **Mutate phase** queues `updateBundle({ enabled: false })` for each target and commits once. Note: `DatabasePlugin.commitBundle` runs ops sequentially in the underlying provider, so atomicity across platforms is **not** guaranteed. The mutate is wrapped in a try/catch so a mid-commit throw still falls through to the verify phase.
  - **Verify phase** re-reads each target. Distinguishes three states — disabled (success), still-enabled (failure), and gone (success: a deleted bundle satisfies the rollback intent). Surfaces partial-failure state explicitly with non-zero exit and per-platform `FAILED` lines naming the exact retry command, including a `--target <bundle-id>` flag for scoped retry.

  Refuses to mutate without `-y` in a non-TTY shell. `onUnmount` is wrapped in its own try/catch so cleanup errors never mask the originating mutation error. Help text documents the four-phase contract and exit codes (0 = success, 1 = error, 2 = user-aborted).

- deff7ab: feat(cli): cli design system
- 8318094: Feature - CLI Rollback
- Updated dependencies [6019156]
  - @hot-updater/cli-tools@0.30.8
  - @hot-updater/plugin-core@0.30.8
  - @hot-updater/console@0.30.8
  - @hot-updater/android-helper@0.30.8
  - @hot-updater/apple-helper@0.30.8
  - @hot-updater/server@0.30.8
  - @hot-updater/core@0.30.8

## 0.30.7

### Patch Changes

- 03fd179: Run the `hot-updater` CLI from native ESM on Node 20 so TypeScript config
  files load through ESM import conditions.

  Require Node.js 20.19.0 or newer for the CLI package surface.

  Run the `hot-updater` CLI bin from the native ESM entrypoint and stop emitting
  a CommonJS build for the CLI entry.

  Bump the `hot-updater` CLI package's vulnerable `kysely` and
  `fast-xml-parser` dependency entries to patched versions without pnpm
  overrides.

- Updated dependencies [03fd179]
  - @hot-updater/apple-helper@0.30.7
  - @hot-updater/cli-tools@0.30.7
  - @hot-updater/android-helper@0.30.7
  - @hot-updater/console@0.30.7
  - @hot-updater/core@0.30.7
  - @hot-updater/server@0.30.7
  - @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- 82de1c6: fix(deps): widen `@expo/fingerprint` to caret range to allow dedupe with Expo SDK
  - @hot-updater/android-helper@0.30.6
  - @hot-updater/apple-helper@0.30.6
  - @hot-updater/cli-tools@0.30.6
  - @hot-updater/console@0.30.6
  - @hot-updater/core@0.30.6
  - @hot-updater/server@0.30.6
  - @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/android-helper@0.30.5
- @hot-updater/apple-helper@0.30.5
- @hot-updater/cli-tools@0.30.5
- @hot-updater/console@0.30.5
- @hot-updater/core@0.30.5
- @hot-updater/server@0.30.5
- @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/android-helper@0.30.4
- @hot-updater/apple-helper@0.30.4
- @hot-updater/cli-tools@0.30.4
- @hot-updater/console@0.30.4
- @hot-updater/core@0.30.4
- @hot-updater/server@0.30.4
- @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/android-helper@0.30.3
- @hot-updater/apple-helper@0.30.3
- @hot-updater/cli-tools@0.30.3
- @hot-updater/console@0.30.3
- @hot-updater/core@0.30.3
- @hot-updater/server@0.30.3
- @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/android-helper@0.30.2
- @hot-updater/apple-helper@0.30.2
- @hot-updater/cli-tools@0.30.2
- @hot-updater/console@0.30.2
- @hot-updater/core@0.30.2
- @hot-updater/server@0.30.2
- @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- 5a7cb26: feat(cli): check infra in hot-updater doctor
- Updated dependencies [35b8720]
  - @hot-updater/console@0.30.1
  - @hot-updater/android-helper@0.30.1
  - @hot-updater/apple-helper@0.30.1
  - @hot-updater/cli-tools@0.30.1
  - @hot-updater/core@0.30.1
  - @hot-updater/server@0.30.1
  - @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/console@0.30.0
  - @hot-updater/server@0.30.0
  - @hot-updater/core@0.30.0
  - @hot-updater/android-helper@0.30.0
  - @hot-updater/apple-helper@0.30.0
  - @hot-updater/cli-tools@0.30.0
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- Updated dependencies [28e14aa]
  - @hot-updater/console@0.29.8
  - @hot-updater/android-helper@0.29.8
  - @hot-updater/apple-helper@0.29.8
  - @hot-updater/cli-tools@0.29.8
  - @hot-updater/core@0.29.8
  - @hot-updater/server@0.29.8
  - @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/android-helper@0.29.7
- @hot-updater/apple-helper@0.29.7
- @hot-updater/cli-tools@0.29.7
- @hot-updater/console@0.29.7
- @hot-updater/core@0.29.7
- @hot-updater/server@0.29.7
- @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- 5a2d37c: Fix the local `fix-ci` runner so the integration step finishes cleanly after
  background emulator processes exit.
- Updated dependencies [80cce61]
  - @hot-updater/cli-tools@0.29.6
  - @hot-updater/android-helper@0.29.6
  - @hot-updater/apple-helper@0.29.6
  - @hot-updater/console@0.29.6
  - @hot-updater/core@0.29.6
  - @hot-updater/server@0.29.6
  - @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- Updated dependencies [52208f4]
  - @hot-updater/server@0.29.5
  - @hot-updater/plugin-core@0.29.5
  - @hot-updater/android-helper@0.29.5
  - @hot-updater/apple-helper@0.29.5
  - @hot-updater/cli-tools@0.29.5
  - @hot-updater/console@0.29.5
  - @hot-updater/core@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/android-helper@0.29.4
- @hot-updater/apple-helper@0.29.4
- @hot-updater/cli-tools@0.29.4
- @hot-updater/console@0.29.4
- @hot-updater/core@0.29.4
- @hot-updater/server@0.29.4
- @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- ca2e17d: refactor(cli): deploy log align print
- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3
  - @hot-updater/console@0.29.3
  - @hot-updater/server@0.29.3
  - @hot-updater/android-helper@0.29.3
  - @hot-updater/apple-helper@0.29.3
  - @hot-updater/cli-tools@0.29.3
  - @hot-updater/core@0.29.3

## 0.29.2

### Patch Changes

- 2a1bc80: fix: node deps bundling
- Updated dependencies [2a1bc80]
  - @hot-updater/cli-tools@0.29.2
  - @hot-updater/core@0.29.2
  - @hot-updater/server@0.29.2
  - @hot-updater/plugin-core@0.29.2
  - @hot-updater/android-helper@0.29.2
  - @hot-updater/apple-helper@0.29.2
  - @hot-updater/console@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/android-helper@0.29.1
- @hot-updater/apple-helper@0.29.1
- @hot-updater/cli-tools@0.29.1
- @hot-updater/console@0.29.1
- @hot-updater/core@0.29.1
- @hot-updater/server@0.29.1
- @hot-updater/plugin-core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
- Updated dependencies [a935992]
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/cli-tools@0.29.0
  - @hot-updater/console@0.29.0
  - @hot-updater/server@0.29.0
  - @hot-updater/core@0.29.0
  - @hot-updater/android-helper@0.29.0
  - @hot-updater/apple-helper@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/android-helper@0.28.0
- @hot-updater/apple-helper@0.28.0
- @hot-updater/cli-tools@0.28.0
- @hot-updater/console@0.28.0
- @hot-updater/core@0.28.0
- @hot-updater/server@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/server@0.27.1
- @hot-updater/android-helper@0.27.1
- @hot-updater/apple-helper@0.27.1
- @hot-updater/cli-tools@0.27.1
- @hot-updater/console@0.27.1
- @hot-updater/core@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/android-helper@0.27.0
  - @hot-updater/apple-helper@0.27.0
  - @hot-updater/cli-tools@0.27.0
  - @hot-updater/console@0.27.0
  - @hot-updater/core@0.27.0
  - @hot-updater/server@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/server@0.26.2
- @hot-updater/android-helper@0.26.2
- @hot-updater/apple-helper@0.26.2
- @hot-updater/cli-tools@0.26.2
- @hot-updater/console@0.26.2
- @hot-updater/core@0.26.2
- @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/android-helper@0.26.1
- @hot-updater/apple-helper@0.26.1
- @hot-updater/cli-tools@0.26.1
- @hot-updater/console@0.26.1
- @hot-updater/core@0.26.1
- @hot-updater/server@0.26.1
- @hot-updater/plugin-core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/android-helper@0.26.0
- @hot-updater/apple-helper@0.26.0
- @hot-updater/cli-tools@0.26.0
- @hot-updater/console@0.26.0
- @hot-updater/core@0.26.0
- @hot-updater/server@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/server@0.25.14
- @hot-updater/android-helper@0.25.14
- @hot-updater/apple-helper@0.25.14
- @hot-updater/cli-tools@0.25.14
- @hot-updater/console@0.25.14
- @hot-updater/core@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- 169b019: chore: bump fast-xml-parser
- Updated dependencies [169b019]
  - @hot-updater/apple-helper@0.25.13
  - @hot-updater/android-helper@0.25.13
  - @hot-updater/cli-tools@0.25.13
  - @hot-updater/console@0.25.13
  - @hot-updater/core@0.25.13
  - @hot-updater/server@0.25.13
  - @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- 38b2af0: fix(expo): android template SDK 55
  - @hot-updater/android-helper@0.25.12
  - @hot-updater/apple-helper@0.25.12
  - @hot-updater/cli-tools@0.25.12
  - @hot-updater/console@0.25.12
  - @hot-updater/core@0.25.12
  - @hot-updater/server@0.25.12
  - @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/android-helper@0.25.11
- @hot-updater/apple-helper@0.25.11
- @hot-updater/cli-tools@0.25.11
- @hot-updater/console@0.25.11
- @hot-updater/core@0.25.11
- @hot-updater/server@0.25.11
- @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- Updated dependencies [90f9610]
- Updated dependencies [03c5adc]
  - @hot-updater/android-helper@0.25.10
  - @hot-updater/apple-helper@0.25.10
  - @hot-updater/cli-tools@0.25.10
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/console@0.25.10
  - @hot-updater/server@0.25.10
  - @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- 6b22072: Change the default value of `podInstalls` option in iOS native build scheme to `false`
- Updated dependencies [6b22072]
  - @hot-updater/apple-helper@0.25.9
  - @hot-updater/plugin-core@0.25.9
  - @hot-updater/android-helper@0.25.9
  - @hot-updater/cli-tools@0.25.9
  - @hot-updater/console@0.25.9
  - @hot-updater/server@0.25.9
  - @hot-updater/core@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/android-helper@0.25.8
- @hot-updater/apple-helper@0.25.8
- @hot-updater/cli-tools@0.25.8
- @hot-updater/console@0.25.8
- @hot-updater/core@0.25.8
- @hot-updater/server@0.25.8
- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/android-helper@0.25.7
- @hot-updater/apple-helper@0.25.7
- @hot-updater/cli-tools@0.25.7
- @hot-updater/console@0.25.7
- @hot-updater/core@0.25.7
- @hot-updater/server@0.25.7
- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- c7a0cc5: fix(cli): even though "provider: 'mysql'" is configured, the error still shows the dialect as postgresql
  - @hot-updater/android-helper@0.25.6
  - @hot-updater/apple-helper@0.25.6
  - @hot-updater/cli-tools@0.25.6
  - @hot-updater/console@0.25.6
  - @hot-updater/core@0.25.6
  - @hot-updater/server@0.25.6
  - @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- 8041bab: fix(cli): function parse$4 expects an xml, but some inputs come as binary as well
  - @hot-updater/android-helper@0.25.5
  - @hot-updater/apple-helper@0.25.5
  - @hot-updater/cli-tools@0.25.5
  - @hot-updater/console@0.25.5
  - @hot-updater/core@0.25.5
  - @hot-updater/server@0.25.5
  - @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- Updated dependencies [8c83ff2]
  - @hot-updater/cli-tools@0.25.4
  - @hot-updater/console@0.25.4
  - @hot-updater/server@0.25.4
  - @hot-updater/core@0.25.4
  - @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- cddc20f: feat: add critical conflict check for expo-updates
  - @hot-updater/cli-tools@0.25.3
  - @hot-updater/console@0.25.3
  - @hot-updater/core@0.25.3
  - @hot-updater/server@0.25.3
  - @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/cli-tools@0.25.2
- @hot-updater/console@0.25.2
- @hot-updater/core@0.25.2
- @hot-updater/server@0.25.2
- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/cli-tools@0.25.1
- @hot-updater/console@0.25.1
- @hot-updater/core@0.25.1
- @hot-updater/server@0.25.1
- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Minor Changes

- d22b48a: feat(expo): expo 'use dom' correct ota update

### Patch Changes

- @hot-updater/cli-tools@0.25.0
- @hot-updater/console@0.25.0
- @hot-updater/core@0.25.0
- @hot-updater/server@0.25.0
- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/cli-tools@0.24.7
  - @hot-updater/console@0.24.7
  - @hot-updater/core@0.24.7
  - @hot-updater/server@0.24.7
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- 9d7b6af: feat(aws): sso template with fromSSO
- 962ecdd: fix(expo): fingerprint autolinking for expo
- Updated dependencies [9d7b6af]
  - @hot-updater/cli-tools@0.24.6
  - @hot-updater/console@0.24.6
  - @hot-updater/server@0.24.6
  - @hot-updater/core@0.24.6
  - @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- f755c3c: Add build\* to default fingerprint ignore paths
  - @hot-updater/cli-tools@0.24.5
  - @hot-updater/console@0.24.5
  - @hot-updater/core@0.24.5
  - @hot-updater/server@0.24.5
  - @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4
  - @hot-updater/cli-tools@0.24.4
  - @hot-updater/console@0.24.4
  - @hot-updater/server@0.24.4
  - @hot-updater/core@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/cli-tools@0.24.3
- @hot-updater/console@0.24.3
- @hot-updater/core@0.24.3
- @hot-updater/server@0.24.3
- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/cli-tools@0.24.2
- @hot-updater/console@0.24.2
- @hot-updater/core@0.24.2
- @hot-updater/server@0.24.2
- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/cli-tools@0.24.1
- @hot-updater/console@0.24.1
- @hot-updater/core@0.24.1
- @hot-updater/server@0.24.1
- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/cli-tools@0.24.0
- @hot-updater/console@0.24.0
- @hot-updater/core@0.24.0
- @hot-updater/server@0.24.0
- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- 7fa9a20: feat(expo): bundle-signing supports cng plugin
  - @hot-updater/cli-tools@0.23.1
  - @hot-updater/console@0.23.1
  - @hot-updater/core@0.23.1
  - @hot-updater/server@0.23.1
  - @hot-updater/plugin-core@0.23.1

## 0.23.0

### Minor Changes

- e41fb6b: feat: add bundle signing for cryptographic OTA verification

### Patch Changes

- Updated dependencies [e41fb6b]
  - @hot-updater/core@0.23.0
  - @hot-updater/console@0.23.0
  - @hot-updater/server@0.23.0
  - @hot-updater/plugin-core@0.23.0
  - @hot-updater/cli-tools@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/cli-tools@0.22.2
- @hot-updater/console@0.22.2
- @hot-updater/core@0.22.2
- @hot-updater/server@0.22.2
- @hot-updater/aws@0.22.2
- @hot-updater/cloudflare@0.22.2
- @hot-updater/firebase@0.22.2
- @hot-updater/plugin-core@0.22.2
- @hot-updater/supabase@0.22.2

## 0.22.1

### Patch Changes

- Updated dependencies [422bf89]
  - @hot-updater/console@0.22.1
  - @hot-updater/cli-tools@0.22.1
  - @hot-updater/core@0.22.1
  - @hot-updater/server@0.22.1
  - @hot-updater/aws@0.22.1
  - @hot-updater/cloudflare@0.22.1
  - @hot-updater/firebase@0.22.1
  - @hot-updater/plugin-core@0.22.1
  - @hot-updater/supabase@0.22.1

## 0.22.0

### Patch Changes

- Updated dependencies [32ad614]
  - @hot-updater/server@0.22.0
  - @hot-updater/cli-tools@0.22.0
  - @hot-updater/console@0.22.0
  - @hot-updater/core@0.22.0
  - @hot-updater/aws@0.22.0
  - @hot-updater/cloudflare@0.22.0
  - @hot-updater/firebase@0.22.0
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/supabase@0.22.0

## 0.21.15

### Patch Changes

- Updated dependencies [a169f06]
  - @hot-updater/server@0.21.15
  - @hot-updater/cli-tools@0.21.15
  - @hot-updater/aws@0.21.15
  - @hot-updater/cloudflare@0.21.15
  - @hot-updater/firebase@0.21.15
  - @hot-updater/plugin-core@0.21.15
  - @hot-updater/console@0.21.15
  - @hot-updater/core@0.21.15
  - @hot-updater/supabase@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/cli-tools@0.21.14
- @hot-updater/console@0.21.14
- @hot-updater/core@0.21.14
- @hot-updater/server@0.21.14
- @hot-updater/aws@0.21.14
- @hot-updater/cloudflare@0.21.14
- @hot-updater/firebase@0.21.14
- @hot-updater/plugin-core@0.21.14
- @hot-updater/supabase@0.21.14

## 0.21.13

### Patch Changes

- 44f4e95: Fix processing of directory glob patterns on extraSources
  - @hot-updater/cli-tools@0.21.13
  - @hot-updater/console@0.21.13
  - @hot-updater/core@0.21.13
  - @hot-updater/server@0.21.13
  - @hot-updater/aws@0.21.13
  - @hot-updater/cloudflare@0.21.13
  - @hot-updater/firebase@0.21.13
  - @hot-updater/plugin-core@0.21.13
  - @hot-updater/supabase@0.21.13

## 0.21.12

### Patch Changes

- 56e849b: chore(server): storagePlugins to storages
- Updated dependencies [56e849b]
- Updated dependencies [5c4b98e]
  - @hot-updater/server@0.21.12
  - @hot-updater/plugin-core@0.21.12
  - @hot-updater/cloudflare@0.21.12
  - @hot-updater/firebase@0.21.12
  - @hot-updater/supabase@0.21.12
  - @hot-updater/aws@0.21.12
  - @hot-updater/cli-tools@0.21.12
  - @hot-updater/console@0.21.12
  - @hot-updater/core@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- 2905e47: feat(server): supports hot-updater database plugin style
- Updated dependencies [d6c3a65]
- Updated dependencies [7ee2830]
- Updated dependencies [e2b67d7]
- Updated dependencies [2905e47]
  - @hot-updater/cli-tools@0.21.11
  - @hot-updater/server@0.21.11
  - @hot-updater/console@0.21.11
  - @hot-updater/core@0.21.11
  - @hot-updater/aws@0.21.11
  - @hot-updater/cloudflare@0.21.11
  - @hot-updater/firebase@0.21.11
  - @hot-updater/plugin-core@0.21.11
  - @hot-updater/supabase@0.21.11

## 0.21.10

### Patch Changes

- Updated dependencies [5289b17]
  - @hot-updater/server@0.21.10
  - @hot-updater/cli-tools@0.21.10
  - @hot-updater/aws@0.21.10
  - @hot-updater/cloudflare@0.21.10
  - @hot-updater/firebase@0.21.10
  - @hot-updater/plugin-core@0.21.10
  - @hot-updater/console@0.21.10
  - @hot-updater/core@0.21.10
  - @hot-updater/supabase@0.21.10

## 0.21.9

### Patch Changes

- 396ae54: feat(cli): db generate --sql create only sql
- aa399a6: chore: deps picocolors
- Updated dependencies [aa399a6]
  - @hot-updater/plugin-core@0.21.9
  - @hot-updater/cli-tools@0.21.9
  - @hot-updater/console@0.21.9
  - @hot-updater/server@0.21.9
  - @hot-updater/aws@0.21.9
  - @hot-updater/cloudflare@0.21.9
  - @hot-updater/firebase@0.21.9
  - @hot-updater/supabase@0.21.9
  - @hot-updater/core@0.21.9

## 0.21.8

### Patch Changes

- 3fe8c81: feat(plugin-core): reduced deps for edge-runtime
- Updated dependencies [3fe8c81]
  - @hot-updater/plugin-core@0.21.8
  - @hot-updater/cli-tools@0.21.8
  - @hot-updater/cloudflare@0.21.8
  - @hot-updater/firebase@0.21.8
  - @hot-updater/aws@0.21.8
  - @hot-updater/console@0.21.8
  - @hot-updater/supabase@0.21.8
  - @hot-updater/core@0.21.8

## 0.21.7

### Patch Changes

- Updated dependencies [2b408f2]
  - @hot-updater/plugin-core@0.21.7
  - @hot-updater/cloudflare@0.21.7
  - @hot-updater/firebase@0.21.7
  - @hot-updater/supabase@0.21.7
  - @hot-updater/aws@0.21.7
  - @hot-updater/console@0.21.7
  - @hot-updater/core@0.21.7

## 0.21.6

### Patch Changes

- b12394d: feat(cli): create migration sql hot-updater generate-db
  - @hot-updater/console@0.21.6
  - @hot-updater/core@0.21.6
  - @hot-updater/aws@0.21.6
  - @hot-updater/cloudflare@0.21.6
  - @hot-updater/firebase@0.21.6
  - @hot-updater/plugin-core@0.21.6
  - @hot-updater/supabase@0.21.6

## 0.21.5

### Patch Changes

- fc2bd56: feat: Add disabled option to deploy command
- a253498: chore(cli): replace es-git with native Git commands
  - @hot-updater/console@0.21.5
  - @hot-updater/core@0.21.5
  - @hot-updater/aws@0.21.5
  - @hot-updater/cloudflare@0.21.5
  - @hot-updater/firebase@0.21.5
  - @hot-updater/plugin-core@0.21.5
  - @hot-updater/supabase@0.21.5

## 0.21.4

### Patch Changes

- Updated dependencies [5d3070a]
  - @hot-updater/plugin-core@0.21.4
  - @hot-updater/aws@0.21.4
  - @hot-updater/cloudflare@0.21.4
  - @hot-updater/firebase@0.21.4
  - @hot-updater/console@0.21.4
  - @hot-updater/supabase@0.21.4
  - @hot-updater/core@0.21.4

## 0.21.3

### Patch Changes

- @hot-updater/console@0.21.3
- @hot-updater/core@0.21.3
- @hot-updater/aws@0.21.3
- @hot-updater/cloudflare@0.21.3
- @hot-updater/firebase@0.21.3
- @hot-updater/plugin-core@0.21.3
- @hot-updater/supabase@0.21.3

## 0.21.2

### Patch Changes

- Updated dependencies [b72da6e]
  - @hot-updater/firebase@0.21.2
  - @hot-updater/console@0.21.2
  - @hot-updater/core@0.21.2
  - @hot-updater/aws@0.21.2
  - @hot-updater/cloudflare@0.21.2
  - @hot-updater/plugin-core@0.21.2
  - @hot-updater/supabase@0.21.2

## 0.21.1

### Patch Changes

- Updated dependencies [7b7bc48]
  - @hot-updater/plugin-core@0.21.1
  - @hot-updater/console@0.21.1
  - @hot-updater/aws@0.21.1
  - @hot-updater/cloudflare@0.21.1
  - @hot-updater/firebase@0.21.1
  - @hot-updater/supabase@0.21.1
  - @hot-updater/core@0.21.1

## 0.22.0

### Minor Changes

- 610b2dd: feat: supports `compressStrategy` => `tar.br` (brotli) / `tar.gz` (gzip)
- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

### Patch Changes

- Updated dependencies [610b2dd]
- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/cloudflare@0.22.0
  - @hot-updater/firebase@0.22.0
  - @hot-updater/supabase@0.22.0
  - @hot-updater/aws@0.22.0
  - @hot-updater/console@0.22.0
  - @hot-updater/core@0.22.0

## 0.20.15

### Patch Changes

- Updated dependencies [526a5ba]
- Updated dependencies [ddf6f2c]
  - @hot-updater/plugin-core@0.20.15
  - @hot-updater/console@0.20.15
  - @hot-updater/aws@0.20.15
  - @hot-updater/cloudflare@0.20.15
  - @hot-updater/firebase@0.20.15
  - @hot-updater/supabase@0.20.15
  - @hot-updater/core@0.20.15

## 0.20.14

### Patch Changes

- Updated dependencies [a61fa0e]
  - @hot-updater/plugin-core@0.20.14
  - @hot-updater/aws@0.20.14
  - @hot-updater/console@0.20.14
  - @hot-updater/cloudflare@0.20.14
  - @hot-updater/firebase@0.20.14
  - @hot-updater/supabase@0.20.14
  - @hot-updater/core@0.20.14

## 0.20.13

### Patch Changes

- @hot-updater/console@0.20.13
- @hot-updater/core@0.20.13
- @hot-updater/aws@0.20.13
- @hot-updater/cloudflare@0.20.13
- @hot-updater/firebase@0.20.13
- @hot-updater/plugin-core@0.20.13
- @hot-updater/supabase@0.20.13

## 0.20.12

### Patch Changes

- @hot-updater/console@0.20.12
- @hot-updater/core@0.20.12
- @hot-updater/aws@0.20.12
- @hot-updater/cloudflare@0.20.12
- @hot-updater/firebase@0.20.12
- @hot-updater/plugin-core@0.20.12
- @hot-updater/supabase@0.20.12

## 0.20.11

### Patch Changes

- afb3a6e: fix(fingerprint): separate fingerprint generation for cng
- cb9c05b: feat(fingerprint): bring back ignorePaths
- Updated dependencies [cb9c05b]
  - @hot-updater/plugin-core@0.20.11
  - @hot-updater/console@0.20.11
  - @hot-updater/aws@0.20.11
  - @hot-updater/cloudflare@0.20.11
  - @hot-updater/firebase@0.20.11
  - @hot-updater/supabase@0.20.11
  - @hot-updater/core@0.20.11

## 0.20.10

### Patch Changes

- 6b5435c: Ignore android/ios folder changes in fingerprint to avoid mismatch after prebuild
  - @hot-updater/console@0.20.10
  - @hot-updater/core@0.20.10
  - @hot-updater/aws@0.20.10
  - @hot-updater/cloudflare@0.20.10
  - @hot-updater/firebase@0.20.10
  - @hot-updater/plugin-core@0.20.10
  - @hot-updater/supabase@0.20.10

## 0.20.9

### Patch Changes

- Updated dependencies [5cbea75]
  - @hot-updater/cloudflare@0.20.9
  - @hot-updater/console@0.20.9
  - @hot-updater/core@0.20.9
  - @hot-updater/aws@0.20.9
  - @hot-updater/firebase@0.20.9
  - @hot-updater/plugin-core@0.20.9
  - @hot-updater/supabase@0.20.9

## 0.20.8

### Patch Changes

- ad7c999: feat(fingerprint): calculate OTA fingerprint only in native module
- Updated dependencies [ad7c999]
  - @hot-updater/plugin-core@0.20.8
  - @hot-updater/console@0.20.8
  - @hot-updater/aws@0.20.8
  - @hot-updater/cloudflare@0.20.8
  - @hot-updater/firebase@0.20.8
  - @hot-updater/supabase@0.20.8
  - @hot-updater/core@0.20.8

## 0.20.7

### Patch Changes

- a92992c: chore(tsdown): failOnWarn true
- Updated dependencies [a92992c]
  - @hot-updater/plugin-core@0.20.7
  - @hot-updater/cloudflare@0.20.7
  - @hot-updater/console@0.20.7
  - @hot-updater/firebase@0.20.7
  - @hot-updater/supabase@0.20.7
  - @hot-updater/core@0.20.7
  - @hot-updater/aws@0.20.7

## 0.20.6

### Patch Changes

- Updated dependencies [6a905d8]
  - @hot-updater/plugin-core@0.20.6
  - @hot-updater/console@0.20.6
  - @hot-updater/aws@0.20.6
  - @hot-updater/cloudflare@0.20.6
  - @hot-updater/firebase@0.20.6
  - @hot-updater/supabase@0.20.6
  - @hot-updater/core@0.20.6

## 0.20.5

### Patch Changes

- @hot-updater/console@0.20.5
- @hot-updater/core@0.20.5
- @hot-updater/aws@0.20.5
- @hot-updater/cloudflare@0.20.5
- @hot-updater/firebase@0.20.5
- @hot-updater/plugin-core@0.20.5
- @hot-updater/supabase@0.20.5

## 0.20.4

### Patch Changes

- 5314b31: feat(rock): intergration formerly rnef
- Updated dependencies [5314b31]
- Updated dependencies [711392b]
  - @hot-updater/plugin-core@0.20.4
  - @hot-updater/cloudflare@0.20.4
  - @hot-updater/firebase@0.20.4
  - @hot-updater/supabase@0.20.4
  - @hot-updater/aws@0.20.4
  - @hot-updater/console@0.20.4
  - @hot-updater/core@0.20.4

## 0.20.3

### Patch Changes

- e63056a: fix(cli): platform parser from hot-updater.config
- Updated dependencies [e63056a]
  - @hot-updater/plugin-core@0.20.3
  - @hot-updater/console@0.20.3
  - @hot-updater/aws@0.20.3
  - @hot-updater/cloudflare@0.20.3
  - @hot-updater/firebase@0.20.3
  - @hot-updater/supabase@0.20.3
  - @hot-updater/core@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [0e78fb0]
  - @hot-updater/plugin-core@0.20.2
  - @hot-updater/console@0.20.2
  - @hot-updater/aws@0.20.2
  - @hot-updater/cloudflare@0.20.2
  - @hot-updater/firebase@0.20.2
  - @hot-updater/supabase@0.20.2
  - @hot-updater/core@0.20.2

## 0.20.1

### Patch Changes

- a3a4a28: feat(cli): set stringResourcePaths and infoPlistPaths in hot-updater.config.ts
- 42ff0e1: chore: bump @expo/fingerprint
- Updated dependencies [a3a4a28]
- Updated dependencies [b7b83ae]
  - @hot-updater/plugin-core@0.20.1
  - @hot-updater/console@0.20.1
  - @hot-updater/aws@0.20.1
  - @hot-updater/cloudflare@0.20.1
  - @hot-updater/firebase@0.20.1
  - @hot-updater/supabase@0.20.1
  - @hot-updater/core@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [a0e538c]
- Updated dependencies [bc8e23d]
  - @hot-updater/cloudflare@0.20.0
  - @hot-updater/plugin-core@0.20.0
  - @hot-updater/console@0.20.0
  - @hot-updater/aws@0.20.0
  - @hot-updater/firebase@0.20.0
  - @hot-updater/supabase@0.20.0
  - @hot-updater/core@0.20.0

## 0.19.10

### Patch Changes

- 85b236d: skip gitignore and package json scripts
- 8d2d55a: Injectable minimum bundle id for Android
- Updated dependencies [a3c0901]
- Updated dependencies [4be92bd]
- Updated dependencies [2bc52e8]
  - @hot-updater/firebase@0.19.10
  - @hot-updater/cloudflare@0.19.10
  - @hot-updater/supabase@0.19.10
  - @hot-updater/aws@0.19.10
  - @hot-updater/plugin-core@0.19.10
  - @hot-updater/console@0.19.10
  - @hot-updater/core@0.19.10

## 0.19.9

### Patch Changes

- Updated dependencies [bcf6798]
  - @hot-updater/aws@0.19.9
  - @hot-updater/console@0.19.9
  - @hot-updater/core@0.19.9
  - @hot-updater/cloudflare@0.19.9
  - @hot-updater/firebase@0.19.9
  - @hot-updater/plugin-core@0.19.9
  - @hot-updater/supabase@0.19.9

## 0.19.8

### Patch Changes

- 4a6a769: feat(cli): show fingerprint diff
  - @hot-updater/console@0.19.8
  - @hot-updater/core@0.19.8
  - @hot-updater/aws@0.19.8
  - @hot-updater/cloudflare@0.19.8
  - @hot-updater/firebase@0.19.8
  - @hot-updater/plugin-core@0.19.8
  - @hot-updater/supabase@0.19.8

## 0.19.7

### Patch Changes

- e28313d: chore(cli): move commander to devDependencies and bundle it
- bcc641e: fix(cli): skipping set config `expo prebuild --platform android`
  - @hot-updater/console@0.19.7
  - @hot-updater/core@0.19.7
  - @hot-updater/aws@0.19.7
  - @hot-updater/cloudflare@0.19.7
  - @hot-updater/firebase@0.19.7
  - @hot-updater/plugin-core@0.19.7
  - @hot-updater/supabase@0.19.7

## 0.19.6

### Patch Changes

- 657a10e: Android Native Build - Gradle Build
- Updated dependencies [657a10e]
  - @hot-updater/aws@0.19.6
  - @hot-updater/cloudflare@0.19.6
  - @hot-updater/firebase@0.19.6
  - @hot-updater/plugin-core@0.19.6
  - @hot-updater/console@0.19.6
  - @hot-updater/supabase@0.19.6
  - @hot-updater/core@0.19.6

## 0.19.5

### Patch Changes

- 40d28c2: bump rnef
- Updated dependencies [40d28c2]
  - @hot-updater/console@0.19.5
  - @hot-updater/core@0.19.5
  - @hot-updater/aws@0.19.5
  - @hot-updater/cloudflare@0.19.5
  - @hot-updater/firebase@0.19.5
  - @hot-updater/plugin-core@0.19.5
  - @hot-updater/supabase@0.19.5

## 0.19.4

### Patch Changes

- Updated dependencies [0ddc955]
  - @hot-updater/plugin-core@0.19.4
  - @hot-updater/console@0.19.4
  - @hot-updater/aws@0.19.4
  - @hot-updater/cloudflare@0.19.4
  - @hot-updater/firebase@0.19.4
  - @hot-updater/supabase@0.19.4
  - @hot-updater/core@0.19.4

## 0.19.3

### Patch Changes

- 0c0ab1d: Add debug option while creating fingerprint
- Updated dependencies [0c0ab1d]
  - @hot-updater/plugin-core@0.19.3
  - @hot-updater/console@0.19.3
  - @hot-updater/aws@0.19.3
  - @hot-updater/cloudflare@0.19.3
  - @hot-updater/firebase@0.19.3
  - @hot-updater/supabase@0.19.3
  - @hot-updater/core@0.19.3

## 0.19.2

### Patch Changes

- 6aa6cd7: fix: globby to fast-glob unicorn-magic error
  - @hot-updater/console@0.19.2
  - @hot-updater/core@0.19.2
  - @hot-updater/aws@0.19.2
  - @hot-updater/cloudflare@0.19.2
  - @hot-updater/firebase@0.19.2
  - @hot-updater/plugin-core@0.19.2
  - @hot-updater/supabase@0.19.2

## 0.19.1

### Patch Changes

- 755b9fe: fix(expo): ensure fingerprint when prebuild
  - @hot-updater/console@0.19.1
  - @hot-updater/core@0.19.1
  - @hot-updater/aws@0.19.1
  - @hot-updater/cloudflare@0.19.1
  - @hot-updater/firebase@0.19.1
  - @hot-updater/plugin-core@0.19.1
  - @hot-updater/supabase@0.19.1

## 0.19.0

### Minor Changes

- c408819: feat(expo): channel supports expo cng
- 886809d: fix(babel): make sure the backend can handle channel changes for a bundle and still receive updates correctly

### Patch Changes

- Updated dependencies [886809d]
- Updated dependencies [fb846ce]
- Updated dependencies [75e82a8]
  - @hot-updater/plugin-core@0.19.0
  - @hot-updater/firebase@0.19.0
  - @hot-updater/console@0.19.0
  - @hot-updater/aws@0.19.0
  - @hot-updater/cloudflare@0.19.0
  - @hot-updater/supabase@0.19.0
  - @hot-updater/core@0.19.0

## 0.18.5

### Patch Changes

- Updated dependencies [494ce31]
  - @hot-updater/plugin-core@0.18.5
  - @hot-updater/cloudflare@0.18.5
  - @hot-updater/console@0.18.5
  - @hot-updater/firebase@0.18.5
  - @hot-updater/supabase@0.18.5
  - @hot-updater/aws@0.18.5
  - @hot-updater/core@0.18.5

## 0.18.4

### Patch Changes

- c6c4838: cancellation of platform selection prompt shows log correctly
  - @hot-updater/console@0.18.4
  - @hot-updater/core@0.18.4
  - @hot-updater/aws@0.18.4
  - @hot-updater/cloudflare@0.18.4
  - @hot-updater/firebase@0.18.4
  - @hot-updater/plugin-core@0.18.4
  - @hot-updater/supabase@0.18.4

## 0.18.3

### Patch Changes

- 34b96c1: fix(native): extracted bundle.zip directly into folder
- d56a2b3: hot-updater doctor
- 72f881c: channel set <channel> after create fingerprint
- 85fc787: fix doctor command check semver version
- 894b2bc: `app-version` shows naive native app version with refactored version utilties
- Updated dependencies [d56a2b3]
  - @hot-updater/aws@0.18.3
  - @hot-updater/console@0.18.3
  - @hot-updater/core@0.18.3
  - @hot-updater/cloudflare@0.18.3
  - @hot-updater/firebase@0.18.3
  - @hot-updater/plugin-core@0.18.3
  - @hot-updater/supabase@0.18.3

## 0.18.2

### Patch Changes

- 70c7f11: fix: no exit deploy in warning state
- Updated dependencies [437c98e]
- Updated dependencies [70c7f11]
  - @hot-updater/plugin-core@0.18.2
  - @hot-updater/cloudflare@0.18.2
  - @hot-updater/console@0.18.2
  - @hot-updater/firebase@0.18.2
  - @hot-updater/supabase@0.18.2
  - @hot-updater/aws@0.18.2
  - @hot-updater/core@0.18.2

## 0.18.1

### Patch Changes

- 8bf8f8f: rspress 2.0.0 and llms.txt
- 7db6246: create fingerprint
- Updated dependencies [8bf8f8f]
  - @hot-updater/console@0.18.1
  - @hot-updater/core@0.18.1
  - @hot-updater/aws@0.18.1
  - @hot-updater/cloudflare@0.18.1
  - @hot-updater/firebase@0.18.1
  - @hot-updater/plugin-core@0.18.1
  - @hot-updater/supabase@0.18.1

## 0.18.0

### Minor Changes

- 73ec434: fingerprint-based update stratgy

### Patch Changes

- Updated dependencies [73ec434]
  - @hot-updater/plugin-core@0.18.0
  - @hot-updater/cloudflare@0.18.0
  - @hot-updater/console@0.18.0
  - @hot-updater/firebase@0.18.0
  - @hot-updater/supabase@0.18.0
  - @hot-updater/core@0.18.0
  - @hot-updater/aws@0.18.0
