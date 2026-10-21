# End-to-end tests

Run the same 36 OTA, Remote Config, Console Insights, and vault scenarios locally and in the E2E bot
with `pnpm -w e2e`. Local mode prepares the example app, a PGlite provider and
real S3-compatible storage. It requires no provider account, private bot setup,
or model credentials: the scenarios are deterministic `e2e` tests, described in
[how the suite uses e2e](mobile/README.md#how-the-suite-uses-e2e).

## First local run

Install the Node version in `.node-version`, enable Corepack, and run
`pnpm install --frozen-lockfile` at the repository root. With mise, first install
and activate the repository's pinned Node and Ruby versions (zsh):

```sh
mise trust
mise install
eval "$(mise activate zsh)"
```

Manually installed compatible Node, Ruby and Bundler on `PATH` are also supported.
Start Docker with Linux containers enabled. The first run downloads the pinned
Silo image from `examples-server/hono-dynamodb/docker-compose.yml` and builds the
workspace.

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

## Vault deploy

`vault-signed-ota` deploys as CI does with the
[console's vault](<../docs/content/docs/(latest)/guides/vault.mdx>). The
control server starts a console from
[`examples-server/hono-kysely-pglite/vault-console`](../examples-server/hono-kysely-pglite/vault-console)
with `vault()` and a random master key, over a PGlite database of its own
under the run's results. Before the console starts, `hot-updater db migrate`
creates the vault's tables and `hot-updater secrets token create` issues a
write token and a token that reads `deploy-credentials` and signs with
`bundle-signing-key`. Through the console, `secrets put` stores the example's
signing key and `secrets import` moves a copy of `.env.hotupdater` into the
vault.

The deploy then holds only `HOT_UPDATER_CONSOLE_URL` and that token, also as
`HOT_UPDATER_SIGNING_TOKEN`. While it runs, the config signs with
`remoteSigning` at the console, `.env.hotupdater` is what `secrets import`
left, the local private key is moved away, and the environment holds none of
the env file's variables. The deploy fails unless its bundle carries a
signature, and the device applies it only after it verifies that signature
with its embedded public key. The console needs no profile of its own, so the
scenario runs in every profile and in the bot unchanged. Its logs, under the
results directory, include the tokens it issued.

## Brownfield track

`--track brownfield` runs the same scenarios against the example packaged as
an XCFramework and an AAR inside the native apps in
[`examples/brownfield-host`](../examples/brownfield-host), as the
[brownfield guide](<../docs/content/docs/(latest)/guides/brownfield.mdx>)
describes. The host apps reuse the example's bundle ID, package, display name,
version, and deep-link scheme, and show React Native on every launch, so the
scenarios, the control server, and the bot's device handling run unchanged.

```sh
pnpm -w e2e -- --platform ios --track brownfield --device <simulator-UDID>
pnpm -w e2e -- --platform android --track brownfield --device emulator-5554
```

The track runs the `brownfield` suite,
[`brownfield-scenario-names.json`](brownfield-scenario-names.json): every
default scenario except the three a native app shell cannot host, a headless
launch and the two that reload from JavaScript, plus the two brownfield-only
scenarios of the native update check (`HotUpdaterInstance`), a required update
staged before React Native starts and a minor one that applies at the next
start, and three that run a second instance. `/e2e/jobs/enable-widget` turns
on `widget`, a second React Native runtime under the example with its own
embedded bundle (`examples/v0.85.0/index.widget.js`) on its own channel,
`widget`. As the guide's start does, the host checks for the widget's update
natively before its runtime starts (`/e2e/jobs/wait-for-native-check` with
`instance: "widget"` waits on the reported status); the widget's JavaScript
only calls `HotUpdater.init`. The instances update independently, the
widget's rollback leaves main on its OTA, and the widget's crash rolls back
only the widget. A deploy,
store wait, or store assertion with `instance: "widget"` works on the
widget's bundle and its store under `hot-updater-instances/widget`.
`e2e:build --track brownfield`
packages the frameworks with `brownfield package:ios` and the AAR into
`examples/v0.85.0/android/brownfieldlib/build/maven`, then builds the host
apps.

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
