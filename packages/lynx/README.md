# @hot-updater/lynx

Lynx support is being implemented against the
[approved PRD](../../plans/lynx-support/prd.md). The target is the Lynx engine,
with ReactLynx, VueLynx and OctaneLynx using the same integration contract.

The current package is experimental. Public runtime/build APIs are not frozen.
Native probes and the CLI archive path have passed focused verification;
the complete SDK installation and recovery path is still being integrated. Follow the
[execution ledger](../../plans/lynx-support/execution.md) for verified results
and open requirements.

## Integration being validated

- Applications own compilation or supply prebuilt native output. The build
  integration preserves selected file bytes, names and dependency paths, assigns
  a Bundle ID, and identifies the entry and declared native compatibility profile.
- Runtime and Node build entrypoints stay separate, with no mandatory UI
  framework dependency. Native module calls originate in background scripting;
  importing the SDK must remain safe in both execution graphs.
- Native verifies the archive, manifest, entry metadata and compatibility before
  evaluating a candidate. It owns process selection, resource resolution,
  startup confirmation and recovery.
- React Native and Lynx use separate backend/catalog/storage projects initially.
  A channel or app version does not identify a native compatibility contract.

The [example](../../examples/lynx) contains production compiler fixtures and
private Sparkling host probes for both operating systems. Manual fixture
placement and successful compilation are not evidence of OTA installation.
The exact supported resource and readiness boundaries are being tested there.

The example's real outputs have passed through the CLI, including signed archives
and multiple native bundle files. Full framework/OS OTA acceptance remains
required before claiming the integration is complete.

## Provisional runtime contract

Create the same controller in each UI framework and invoke its methods from
Lynx background scripting after the host registers `HotUpdaterLynx`:

```ts
import { createHotUpdater } from "@hot-updater/lynx";

const updater = createHotUpdater({ baseURL: "https://updates.example.com" });

// Call after the application's essential background startup succeeds.
await updater.notifyAppReady();

const update = await updater.checkForUpdate();
if (update) {
  await update.install();
}

const launch = await updater.getLaunchInfo();
```

Importing the package and creating the controller perform no native calls,
network requests or listener registration. The current HTTP implementation needs
`fetch` and `AbortController` in background scripting; their host integration is
part of the native example validation.

`checkForUpdate()` can download files: native prepares and verifies the candidate
before returning it, including its compatibility identity. A known incompatible
candidate rejects with `LynxUpdaterError.code === "INCOMPATIBLE"`. It does not
select an older candidate automatically. `install()` publishes that exact
prepared selection for the next process, subject to a fresh native authorization
check. A stale prepared selection rejects; it cannot silently install a different
update.

`getLaunchInfo().running` describes the current process. `next` describes a staged
selection. Installation leaves the running bytes unchanged. Native may adopt a
new Release for already confirmed running bytes without a restart; matching
cached bytes alone cannot confer startup confirmation.

Readiness requires both the live primary context's native content observation
and successful essential application startup. A secondary, destroyed or stale
context cannot confirm an attempt. These guarantees require the native host and
controller integration; mocked bridge tests alone do not establish them.

## Provisional build contract

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
