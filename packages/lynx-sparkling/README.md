# @hot-updater/lynx-sparkling

Optional Sparkling host integration for `@hot-updater/lynx`. Install both
packages and the pinned `sparkling-navigation@2.1.0-rc.12` peer. Import `navigate`
and `close` from this package's root. Navigation retains Sparkling's page bundle
model while restricting routes to the active verified release.

The `android` library and `ios/HotUpdaterLynxSparkling.podspec` contain the
managed host, resource loading, bridge and runtime recreation. Resolve native
paths through this package's public `package.json`, separately from the Lynx
SDK's native artifact controller. See the [example](../../examples/lynx).

Android applications can extend `HotUpdaterSparklingActivity` and implement
`createHotUpdaterConfiguration()` with their native configuration. The packaged
Activity mounts the primary page, retains and reattaches its host across
configuration changes, and closes it on final destruction. Applications do not
implement this managed lifecycle themselves.

Native launch configuration includes two process-local identities. The
`managedGenerationEpoch` is shared by every page and Activity rebind in one
managed generation and advances when that generation is replaced. The
`runtimeGenerationEpoch` identifies each runtime binding separately and is used
by `managedFontUrl()` to isolate the Lynx font cache. Neither value can be
overridden by application, diagnostic or page parameters. Use the managed
generation when comparing state published by different pages.

Pinned navigation provenance is recorded in the `sparklingNavigation` field of
`package.json`; Node tooling can read it without loading device navigation.
The package includes the approved Fresco compatibility adaptation. No app-side
native workaround is required by this package.
