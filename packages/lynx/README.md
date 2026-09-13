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

Importing the package and calling `init()` do not call native code, register a
listener, or open a network connection. The background runtime must provide
`fetch` and `AbortController`. Response streams use `TextDecoder` and are bounded
as bytes arrive. Without streaming support, the server must send a valid bounded
`Content-Length` header.

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
delivery description, and asks native code to validate compatibility. It does
not download or retain an installation preparation. Calling
`update.updateBundle()` downloads, verifies, and atomically stages that exact
selection. Dropping the returned update object therefore consumes no native
preparation capacity. Repeated calls to the same closure share one installation
promise.

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

Delta delivery is manifest-driven. The manifest declares one
`patchAssetPath`, and each downloadable asset declares
`downloadCompression: "br"` or `downloadCompression: null`. Native chooses the
verified running installation as the base, supports BSDIFF patches, copies only
manifest-covered unchanged files, verifies the reconstructed target hash, and
publishes the complete target atomically. A bad or stale patch may use an
authorized complete-file or archive fallback. Archive fallback is recorded as a
fallback and is not reported as a successful patch application.

The provider-neutral database contract retains at most 24 ordered base patches
for one target Bundle and publishes replacement patch rows atomically. Deleting
a Bundle fails with the common referenced-row result while a Release or another
Bundle's patch still refers to it; built-in providers translate their native
constraint errors to that same contract.

## Build integration

Use the separate `@hot-updater/lynx/build` entrypoint. The application owns its
ReactLynx, VueLynx, or OctaneLynx compiler and writes selected native output into
the empty attempt directory:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { lynx } from "@hot-updater/lynx/build";

const build = lynx({
  build: async ({ cwd, platform, bundleId, outDir }) => {
    await buildNativeLynxFiles({ cwd, platform, bundleId, outDir });
    return {
      entry: "main.lynx.bundle",
      runtimeId: nativeRuntimeIdentity,
    };
  },
  getBundleSigningPublicKey: async ({ cwd }) => ({
    publicKey: await readFile(path.join(cwd, "native/public-key.pem"), "utf8"),
  }),
});
```

The callback returns a portable relative entry path and the exact compatibility
identity embedded by the native binary. The adapter adds
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
`@hot-updater/react-native`, while Expo native fingerprint discovery lives in
the Expo integration.

## Sparkling host

The package contains optional Sparkling integrations for iOS and Android. They
own the Lynx bridge, release-scoped resource loaders, startup observations,
managed-context identities, recovery, and in-process generation replacement.
An application supplies native compatibility and embedded-release configuration,
registers the packaged module, and mounts the packaged host. See the
[Sparkling example](../../examples/lynx) for the production scaffold and its
separate nonproduction acceptance harness.
