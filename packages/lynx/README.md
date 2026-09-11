# @hot-updater/lynx

OTA updates for Lynx apps. ReactLynx, VueLynx, and OctaneLynx share one
integration contract: the same runtime, build plugin, and native controllers
on iOS and Android.

```ts
import { HotUpdater } from "@hot-updater/lynx";

HotUpdater.init({
  baseURL: "https://updates.example.com/hot-updater",
});

await HotUpdater.notifyAppReady();

const update = await HotUpdater.checkForUpdate({
  updateStrategy: "appVersion",
});
if (update) {
  await update.updateBundle();
  if (update.shouldForceUpdate) {
    await HotUpdater.reload();
  }
}
```

This matches the React Native client: `HotUpdater.init`,
`HotUpdater.checkForUpdate`, and `update.updateBundle()`. There is no
`HotUpdater.wrap` HOC. Importing the package does not call native code or
open a network connection.

## How it fits

- Applications own compilation or supply prebuilt native output. The build
  plugin preserves selected file bytes, names, and dependency paths, assigns a
  Bundle ID, and binds the entry to a native compatibility identity.
- Runtime and Node build entrypoints stay separate, with no required React,
  Vue, or Octane dependency.
- Native verifies the archive, manifest, entry metadata, and compatibility
  before evaluating a candidate. It owns process selection, resource
  resolution, startup confirmation, and recovery.
- React Native and Lynx stay in separate app binaries and catalog projects.
  A channel or app version does not identify a native compatibility contract.

The [example](../../examples/lynx) ships ReactLynx, VueLynx, and OctaneLynx
hosts for iOS and Android.

## Runtime contract

Call the same `HotUpdater` object from each UI framework's background
scripting after the host registers `HotUpdaterLynx`:

```ts
import { HotUpdater } from "@hot-updater/lynx";

HotUpdater.init({ baseURL: "https://updates.example.com/hot-updater" });

await HotUpdater.notifyAppReady();

const update = await HotUpdater.checkForUpdate({
  updateStrategy: "appVersion",
});
if (update) {
  await update.updateBundle();
}
```

Importing the package and calling `init` perform no native calls, network
requests, or listener registration. The HTTP client needs `fetch` and
`AbortController` in background scripting.

`checkForUpdate()` can download files: native prepares and verifies the
candidate before returning it. A known incompatible candidate rejects with
`LynxUpdaterError.code === "INCOMPATIBLE"`. `update.updateBundle()` publishes
that exact prepared selection for the next process. A stale prepared selection
rejects; it cannot silently install a different update.

`HotUpdater.getLaunchInfo().running` describes the current process. `next`
describes a staged selection. Installation leaves the running bytes unchanged.

Readiness requires both the live primary context's native content observation
and successful essential application startup. A secondary, destroyed or stale
context cannot confirm an attempt. These guarantees require the native host and
controller integration; mocked bridge tests alone do not establish them.

## Build contract

The `@hot-updater/lynx/build` entrypoint takes an application-owned async `build`
callback. It receives `cwd`, `platform`, a fresh packaging `bundleId`, and an empty
attempt-owned `outDir`. Return `{ entry, runtimeId, stdout? }`, where `entry` is a
relative native file path and `runtimeId` is the exact compatibility identity from
the native build. The callback deliberately selects every managed file to include.

The adapter validates paths and regular files, rejects existing reserved root
metadata names and aliases, writes versioned `hot-updater-lynx.json`, and requests
the CLI's `filePolicy: "preserve"`. The manifest must cover that metadata along
with the selected files. A failed build removes only its own attempt directory.
This contract remains provisional until G1 reconciliation; it does not provide
native verification or make an incompatible artifact executable.

For signed deployments, supply `getBundleSigningPublicKey` alongside the build
callback. It receives `{ cwd }` and resolves `{ publicKey }` or `null`. Read the
public PEM from the configuration consumed by the native build:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { lynx } from "@hot-updater/lynx/build";

const build = lynx({
  build: buildNativeFiles, // Your existing application-owned build callback.
  getBundleSigningPublicKey: async ({ cwd }) => ({
    publicKey: await readFile(path.join(cwd, "native/public-key.pem"), "utf8"),
  }),
});
```

This resolver reports the native binary's trust anchor, not the deployment
signer's private key. The native build must embed that same public key; exporting
a new signer key alone does not update an existing binary. The CLI compares it
with the configured signer before building or uploading. Resolver failures,
missing keys in signed deployments, and mismatched keys stop deployment.

Lynx marks its resolver as the authoritative native signing configuration, so
Info.plist or AndroidManifest files do not trigger React Native key discovery.
Omitting the resolver reports `null`, suitable for a native build without a
signing key. This adds no fingerprint, prebuild, or native configuration generator.
