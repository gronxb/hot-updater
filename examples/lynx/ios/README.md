# Lynx iOS feasibility host

This private G1 host derives from Sparkling's production template at
`c4ce8d25c5ea277e13752d68ff1f2a66f5704240`. It runs real compiled Lynx files in
an iOS release simulator binary. It is not the completed Hot Updater native SDK.

Prerequisites: Xcode and Bundler. Run `./bootstrap.sh` to fetch the pinned
Sparkling sources, install `cocoapods-lynx-library` 3.9.0, and resolve the
locked native dependencies. Sparkling's
2.1.0-rc.12 router pod is unavailable from the CDN, so the local source dependency
is intentional.

Build the root workspace and real framework G1 fixtures first. Then, from this
directory:

```sh
node prepare-fixtures.mjs react vue octane --variant=external2-managed
xcodebuild -workspace SparklingGo.xcworkspace -scheme SparklingGo \
  -configuration Release -sdk iphonesimulator \
  -destination 'id=YOUR_SIMULATOR_UDID' -derivedDataPath .build \
  CODE_SIGNING_ALLOWED=NO build
agent-device install com.hotupdater.lynxexample \
  "$(pwd)/.build/Build/Products/Release-iphonesimulator/SparklingGo.app" \
  --platform ios --udid YOUR_SIMULATOR_UDID --session lynx-ios
agent-device open com.hotupdater.lynxexample --platform ios \
  --udid YOUR_SIMULATOR_UDID --session lynx-ios --foreground
```

The binary embeds A for each prepared framework. The default launch uses React A.
For another fixture, close the process, place the fixture selection, then open
again. Keep the same installed native binary throughout an A/B scenario:

```sh
agent-device close com.hotupdater.lynxexample --session lynx-ios
node place-fixture.mjs YOUR_SIMULATOR_UDID react B
agent-device open com.hotupdater.lynxexample --platform ios \
  --udid YOUR_SIMULATOR_UDID --session lynx-ios --foreground
```

`place-fixture.mjs` is a manual simulator-only setup tool. It copies B into
Application Support and writes a trusted local `launch.json`. Do not use it while
the application is running: replacing files in an active release violates the
production resource-lifetime contract. No production installer is implied.

The host logs JSONL evidence to
`Library/Application Support/HotUpdaterLynxSpike/events.jsonl` in its sandbox.
Each launch records native identity, pre-evaluation integrity validation, exact
resource paths/hashes, native module probes and startup observations.

Only managed `hot-updater:///`, `asset:///` and relative URLs are accepted. There is no network or
alternate-release fallback. The host verifies each manually selected manifest
against the trusted selection hash, then all listed bytes, entry, metadata and
native runtime identity before constructing the candidate view. Archive safety,
configured signing and delivery authorization remain later integration work. The
private host records a scoped durable pending attempt before primary evaluation,
requires native first content, app readiness and verified essential resources for
confirmation, and separates unexplained Release exclusions from known Bundle
failures. Native context identity controls readiness; incompatible artifacts are
cached by binary, scope, Bundle and manifest identity. These G1 implementations
are intentionally separate from a production installer.

See the [iOS evidence record](../../../plans/lynx-support/evidence/ios.md) for
actual results and gaps. Compilation or local placement alone is not OTA support.

Run real simulator scenario probes with `node run-g1-probes.mjs YOUR_SIMULATOR_UDID baseline`
(or `recovery`, `contexts`, `metadata`, `failures`, `capacity`). Each run writes
private JSON evidence and snapshots to `.probe-results/`. Capacity tests seed
128 exclusions in an isolated test scope; they do not claim 128 real crashes.
The probes manually place trusted artifacts and do not exercise OTA downloading.

See [third-party notices](../THIRD_PARTY_NOTICES.md) for the Sparkling source license.
