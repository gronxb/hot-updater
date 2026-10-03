---
"@hot-updater/lynx": minor
"@hot-updater/lynx-build": minor
"@hot-updater/lynx-sparkling": minor
"@hot-updater/test-utils": patch
---

Add Lynx OTA support: a framework-independent runtime and build adapter, iOS
and Android native controllers, and optional packaged Sparkling hosts for
ReactLynx, VueLynx, and OctaneLynx. Support manifest-v1 delivery with verified BSDIFF patches and optional
manifest-authenticated tar.br bulk transfer, nonretained compatibility checks, atomic staging and channel changes,
one-shot launch transition receipts, startup recovery, and in-process recreation
of every managed Lynx runtime and view. Preserve opaque compiler output through
portable, manifest-bound artifact declarations, including a 16 KiB Lynx sidecar
limit. Keep the prerelease API native-authoritative: omit manifest, filesystem
install-identity, user, listener, and insights placeholders; propagate default
native reload failures; require a handler for custom reload; and derive
`isUpdateDownloaded()` from authoritative native next-selection state.
Managed reload resolves only after every registered runtime and view is attached
to the replacement generation and propagates reconstruction failures. Channel
reset persists the default scope before the same recreation and invalidates the
JS state snapshot on success or failure.
The shared acceptance contract requires verified forward A-to-B and B-to-C
BSDIFF and reverse C-to-B and B-to-A BSDIFF without counting archive fallback.

Adapt the pinned Lynx Android image service to Fresco 3.4 within the optional
Sparkling package, retaining source integrity and bitmap/animation behavior.
Use standard application initialization and 16 KB-aligned native packaging.
Include the adaptation in the native compatibility fingerprint.

Keep the device SDK root-only with protocol as its sole dependency. Ship Node
build and init tooling in `@hot-updater/lynx-build`, and Sparkling navigation
and native host integration in `@hot-updater/lynx-sparkling`. Fingerprint the
installed native packages from the application rather than the build adapter.

Publish shared native catalog and manifest fixtures from test-utils, excluding
them from the device SDK install.

Authenticate bounded manifest and Lynx compatibility metadata during update
checks, then reuse that metadata during full installation. Reauthorize after
asynchronous checks and preserve full file, patch, and resource verification
before publication.
