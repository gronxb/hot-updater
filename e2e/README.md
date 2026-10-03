# End-to-end tests

Run the same 27 OTA and Console Insights scenarios locally and in the E2E bot
with `pnpm -w e2e`. Local mode prepares the example app, a PGlite provider and
real S3-compatible storage. It requires no provider account, private bot setup,
or model credentials.

## First local run

Install the Node version in `.node-version`, enable Corepack, and run
`pnpm install --frozen-lockfile` at the repository root. Start Docker with Linux
containers enabled. The first run downloads the pinned Silo image from
`examples-server/hono-dynamodb/docker-compose.yml` and builds the workspace.

For iOS, use macOS with Xcode, its command-line tools, an installed iOS Simulator
runtime, Ruby and Bundler compatible with `examples/v0.85.0/Gemfile.lock`.
The command installs the locked gems into the example's `vendor/bundle`, runs
CocoaPods, and builds a Release simulator app. Select an available simulator:

```sh
xcrun simctl list devices available
pnpm -w e2e -- --platform ios --device <simulator-UDID>
```

For Android, install the React Native Android toolchain, JDK 17, Android SDK and
an emulator. Set `ANDROID_HOME`, put its `platform-tools` on `PATH`, and accept
the SDK licenses. Start the emulator before running:

```sh
adb devices
pnpm -w e2e -- --platform android --device emulator-5554
```

The Android build is a debuggable Release APK so the shared recovery checks can
inspect app-private state with `run-as`. Physical devices are not selected by
local mode. If exactly one device of the requested platform is already booted,
`--device` can be omitted. Multiple booted devices require an explicit ID.
Each invocation owns a private agent-device daemon. Reserve the selected device
for the duration of the run; device ownership is shared across daemons.

To select scenarios or inspect the plan without starting services or accessing
devices:

```sh
pnpm -w e2e -- --list
pnpm -w e2e -- --platform ios --scenario release-ota-recovery --dry-run
pnpm -w e2e -- --platform android --device emulator-5554 --scenario release-ota-recovery
```

Repeat `--scenario` to select several. With no selection, `--suite default`
runs all scenarios. `HOT_UPDATER_E2E_SCENARIOS` also accepts a comma-separated
selection. Results include the normalized `hot-updater-result.json`, SDK report,
scenario diagnostics and Console Insights evidence.

## Local preparation and cleanup

Each invocation allocates loopback ports for the provider, control server and
storage. Android maps device port 3107 to the allocated control port and maps
the provider port with device-specific `adb reverse`; conflicting mappings
fail rather than being replaced. Signed artifact downloads pass through the
provider, so the device does not need a storage-port mapping.

Local preparation creates a new admin token, signing key pair and storage
credentials. It exports the public key before the native build, installs native
dependencies, generates the fingerprint, and then compiles the app. The local
profile uses the published CLI, standalone repository and S3 storage adapters.

The command temporarily replaces the example's config, environment file,
signing keys and native metadata. It restores their original contents and
permissions after success, failure or cancellation. A checkout lock prevents
two local preparers from editing those files at the same time. It stops only
its own provider process group and labeled storage container; it does not kill
services occupying other ports. Native build outputs are retained with run
data; dependency caches can be reused by subsequent runs.

Run data is kept under `e2e/results/local/<run-id>` (ignored by Git): provider
logs, PGlite data, results, and a protected `originals/manifest.json` backup.
These directories can contain private pre-existing config backups and locally
generated credentials; share the results subdirectory only. If the process is
forcibly killed or cleanup fails, inspect the retained checkout lock and use
the manifest to restore the original files before removing that lock.

## Prepared bot runs

The bot keeps ownership of its provider provisioning, native build cache and
device lease. After preparation it invokes the same entry point:

```sh
pnpm -w e2e -- --prepared --platform ios --device <simulator-UDID> \
  --profile <profile> --run-id <job-id> --head-sha <commit-sha> \
  --session <unique-session> --results-dir <output-directory>
```

`--prepared` forwards the remaining arguments and environment to the shared
mobile runner. It does not generate local credentials or start the local
provider. All profiles execute the same scenario definitions and result
contract. Prepared runs supply the provider environment, signing key and built
native app; native builds are available through `pnpm -w e2e:build -- --platform
ios|android`. See [mobile runner details](mobile/README.md) for lifecycle,
cancellation, evidence and binary-path settings.

Checks that do not access devices:

```sh
pnpm -w e2e:test:type
pnpm exec vitest run --project=unit:e2e
```
