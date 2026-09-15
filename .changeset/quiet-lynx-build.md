---
"@hot-updater/lynx": minor
---

Add Lynx OTA support: a framework-independent runtime and build adapter, iOS
and Android native controllers, and optional packaged Sparkling hosts for
ReactLynx, VueLynx, and OctaneLynx. Support full archives and verified BSDIFF
deltas, nonretained compatibility checks, atomic staging and channel changes,
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
