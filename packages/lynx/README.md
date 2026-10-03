# @hot-updater/lynx

OTA updates for applications running on the Lynx engine. ReactLynx, VueLynx,
and OctaneLynx use the same runtime API, build contract, and native controllers
on iOS and Android. The package does not depend on any of those UI frameworks.

## Runtime API

Call the SDK from Lynx background scripting after the native host registers the
`HotUpdaterLynx` module:

```ts
import { HotUpdater } from "@hot-updater/lynx";

HotUpdater.init({
  baseURL: "https://updates.example.com/hot-updater",
});

await HotUpdater.notifyAppReady();

const update = await HotUpdater.checkForUpdate({
  updateStrategy: "appVersion",
});

if (update && (await update.updateBundle()) && update.shouldForceUpdate) {
  await HotUpdater.reload();
}
```

Run update checks, installation, and reload from the host-designated primary
page context. Secondary pages report their own readiness with
`notifyAppReady()`; they cannot authorize or stage an OTA selection. The primary
context can apply an update while a detail page is open, rebuilding the full
managed stack in the same process.

Importing the package and calling `init()` do not call native code, register a
listener, or open a network connection. The background runtime and native
integration must provide `fetch`, `AbortController`, and a readable response
stream through `response.body.getReader()`. Enable standard Fetch streaming in
each page compiler with
`pluginLynxConfig({ enableFetchAPIStandardStreaming: true })`. The SDK bounds
bytes as they arrive. `Content-Length` can reject an oversized response before
reading, but it cannot replace streaming because reading the whole response at
once cannot enforce the allocation bound. The packaged native integrations
support this contract on Lynx 3.9.

`init()` accepts the update server URL, optional request headers and timeout, and
an optional error callback. The public runtime surface is:

- lifecycle: `init`, `checkForUpdate`, the returned update's `updateBundle`,
  `notifyAppReady`, `getLaunchInfo`, `reload`, and
  `setReloadBehavior("custom", handler)`;
- state reads: `isUpdateDownloaded`, `getAppVersion`, `getActiveUpdateState`,
  `getBundleId`, `getMinBundleId`, `getChannel`, `getDefaultChannel`,
  `isChannelSwitched`, `getCohort`, `getFingerprintHash`, and `getCrashHistory`;
- state changes: `setCohort`, `resetChannel`, and `clearCrashHistory`.

The top-level `HotUpdater.updateBundle()` rejects with `USE_CHECK_FOR_UPDATE`;
installation belongs to the update returned by `checkForUpdate()`. The package
does not expose a manifest, filesystem installation identifier, user mutation,
event listener, or insights option because native cannot supply those values or
events authoritatively.

`checkForUpdate()` fetches and authorizes a catalog selection, resolves its
delivery description, and authenticates the manifest and Lynx compatibility
metadata. This step checks runtime identity, declared pages and resources without
downloading page bundles, images, fonts, patches, or the archive. Native code keeps
one bounded metadata snapshot keyed by bundle ID and manifest integrity token.
`update.updateBundle()` reuses matching metadata, verifies the complete artifact,
and atomically stages the selection after rechecking authorization. File corruption
can therefore fail installation even when the metadata check succeeded. The
returned update object retains no native preparation capacity. Repeated calls to
the same closure share one installation promise.

Installation changes the next selection and never changes the bytes used by the
current managed generation. `HotUpdater.reload()` asks the packaged host to
replace every managed Lynx runtime and view in the same foreground OS process.
All replacement contexts receive fresh identities and use one selected release.
An ordinary next launch applies a staged selection independently of reload.

Startup confirmation requires all of the following from the live primary
context:

- a durable native attempt recorded before evaluation;
- actual native first-content observation;
- successful loads of every configured startup resource; and
- the application's `notifyAppReady()` signal.

A fatal startup failure in any managed context retires the generation and uses
the controller's eligible confirmed or embedded fallback. Stale contexts and
callbacks cannot confirm or mutate the replacement generation.

`notifyAppReady()` returns a one-shot native transition receipt. The first valid
confirmation after a transition may report `UPDATE_APPLIED` or `RECOVERED` with
the exact source and target selections. Native consumes that receipt atomically;
later readiness calls report `UNCHANGED`.

## Channels and native state

Pass `channel` to `checkForUpdate()` only for an explicit scope switch:

```ts
await HotUpdater.checkForUpdate({
  updateStrategy: "appVersion",
  channel: "beta",
});
```

Native accepts the target catalog and channel switch under one state revision.
Once switched away from the configured default channel, another cross-channel
check is rejected. Call and await `HotUpdater.resetChannel()` before selecting a
different channel. Reset clears channel-scoped accepted, staged, pending, and
stable state atomically and returns to the configured default channel.

`HotUpdater.getLaunchInfo()` reports the running and staged selections without
exposing native filesystem paths. `HotUpdater.clearCrashHistory()` waits for the
native mutation and refreshes the JS snapshot before resolving.
`HotUpdater.isUpdateDownloaded()` reports whether that authoritative snapshot
contains a staged next selection.

`reload()` calls the packaged native host by default and propagates native
failures to its caller. A custom integration must call
`HotUpdater.setReloadBehavior("custom", handler)` with a handler; there are no
public `reload` or `processRestart` behavior options.

## Artifact and delta contract

Native verifies the signed manifest, every managed target file, the
`hot-updater-lynx.json` sidecar, platform, Bundle ID, and exact runtime identity
before candidate evaluation. Managed paths use canonical portable POSIX syntax.
Absolute paths, backslashes, drive or URL prefixes, empty or dot segments,
control characters, case-insensitive aliases, reserved metadata collisions,
symlinks, and configured size or entry-limit violations are rejected.

Shared packaging limits are 128 MiB for an archive, 128 MiB for each artifact,
512 MiB for total expanded files, and 1 MiB for the signed manifest. The Lynx
sidecar is limited to 16 KiB. Packaging and native verification apply these
limits before publication or execution. Artifact paths and fingerprint inputs
use locale-independent UTF-16 code-unit ordering so equivalent inputs produce
the same metadata and hashes on every host.

Artifact delivery uses manifest v1: an authenticated manifest, a complete
`assets` map with an original file for every target path, and an optional
`archiveUrl`. The manifest declares one
`patchAssetPath`, and each downloadable asset declares
`downloadCompression: "br"` or `downloadCompression: null`. Native chooses the
verified running installation as the base, supports BSDIFF patches, copies only
manifest-covered unchanged files, verifies the reconstructed target hash, and
publishes the complete target atomically. A bad or stale patch uses its verified
original file. Native may choose a bulk `bundle.tar.br` using authenticated
transfer costs; its hash, compressed size, decoded TAR size, and exact file
inventory are verified. A failed bulk transfer falls back to the same original
files. Manifest verification failure stops installation. Native logs distinguish
bulk installation from an actual patch application.

The provider-neutral database contract retains at most 24 ordered base patches
for one target Bundle and publishes replacement patch rows atomically. Deleting
a Bundle fails with the common referenced-row result while a Release refers to
it. Following the 1.0 core lifecycle, deleting an unreferenced Bundle also removes
patches to and from it; targets remain installable through their original files.

## Build integration

Use the separate `@hot-updater/lynx-build` package. The application owns its
ReactLynx, VueLynx, or OctaneLynx compiler and writes selected native output into
the empty attempt directory:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { lynx, type LynxBuildOutput } from "@hot-updater/lynx-build";

const build = lynx({
  build: async ({ cwd, platform, bundleId, outDir }) => {
    const { pageEntries, pageEssentialResources } = await buildNativeLynxFiles({
      cwd,
      platform,
      bundleId,
      outDir,
    });
    return {
      entry: "main.lynx.bundle",
      pageEntries,
      pageEssentialResources,
      runtimeId: nativeRuntimeIdentity,
    } satisfies LynxBuildOutput;
  },
  getBundleSigningPublicKey: async ({ cwd }) => ({
    publicKey: await readFile(path.join(cwd, "native/public-key.pem"), "utf8"),
  }),
});
```

The basic example emits `main.lynx.bundle` and `detail.lynx.bundle`; these names
are example choices. The compiler must emit each declared `pageEntries` path
and return the deterministic page allowlist and exact resource closure from its
dependency graph. For the basic example, that graph is:

```ts
const pageEntries = ["detail.lynx.bundle", "main.lynx.bundle"] as const;
const pageEssentialResources = [
  {
    entry: "detail.lynx.bundle",
    resources: ["detail.lynx.bundle"],
  },
  {
    entry: "main.lynx.bundle",
    resources: [
      "assets/bootstrap.js",
      "assets/probe.png",
      "assets/probe.ttf",
      "dynamic/component.lynx.bundle",
      "main.lynx.bundle",
    ],
  },
] as const;
```

These values come from the compiler's module, chunk, and asset relations; do
not infer them from bundle text or maintain a separate resource list. The
callback also returns the exact compatibility identity embedded by the native
binary. The adapter adds
`hot-updater-lynx.json`, declares every selected file as a build artifact,
declares the entry as `patchAssetPath`, Brotli-compresses that entry for
download, and preserves the other files as raw bytes. It rejects reserved paths,
nonregular files, symlinks, and empty entries before packaging.

The optional signing resolver returns the public key embedded by the native
build. It never returns a private signing key. The CLI compares it with the
configured signer before upload. Lynx also provides a native fingerprint based
on its own host inputs; a custom host may supply a `fingerprint` provider.

Common Hot Updater packaging consumes these explicit declarations without Lynx
or React Native filename rules. React Native/Hermes artifact selection lives in
the Bare, Expo, and Rock build adapters. Bare and Rock own their native
fingerprints, while Expo owns Expo fingerprint discovery.

## Sparkling host

The optional `@hot-updater/lynx-sparkling` package provides Sparkling integrations
for iOS and Android. They
own the Lynx bridge, release-scoped resource loaders, startup observations,
managed-context identities, recovery, and in-process generation replacement.
An application supplies native compatibility and embedded-release configuration,
registers the packaged module, and mounts the packaged host. See the
[Sparkling example](../../examples/lynx) for the production scaffold and its
separate nonproduction acceptance harness.

The device SDK exports only its root and depends only on `@hot-updater/protocol`.
Build tooling and Sparkling dependencies belong to the separate packages above.
The current ready-made host integration requires Sparkling; a plain LynxView
host is not yet provided.
