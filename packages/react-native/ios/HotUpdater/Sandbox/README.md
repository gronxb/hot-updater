# Sandbox layer (iOS)

Compiled only into a build whose `nativeBuild.ios` scheme sets `sandbox: true`.

Three things keep it out of any other build:

1. `HotUpdater.podspec` sets `EXCLUDED_SOURCE_FILE_NAMES = HotUpdaterSandbox*`, and
   only the CLI's build xcconfig sets `INCLUDED_SOURCE_FILE_NAMES` back. A build
   without it, such as one from Xcode, leaves these files out. An app's own
   `EXCLUDED_SOURCE_FILE_NAMES` can replace this one, so it isn't enough alone.
2. Every file here is wrapped whole in `#if HOT_UPDATER_SANDBOX_LAYER`. Only the
   CLI's build xcconfig sets it, so a build that compiles these files without it
   gets empty translation units: no symbols and no `+load`.
3. A `+load` here does nothing unless the main bundle's `Info.plist` has
   `HOT_UPDATER_SANDBOX`, which the CLI writes after the build, and it checks that
   first. Nothing else starts on its own: the entry points are wrapped only from the
   gate's `+load`, and no file here adds an `+initialize` or a constructor.

Add a file here with a name that starts with `HotUpdaterSandbox`, wrapped whole in
`#if HOT_UPDATER_SANDBOX_LAYER` and `#endif`, with only comments outside them.
`sandboxTemplate.spec.ts` fails otherwise. Nothing outside
this directory may refer to it, except `Test/Sandbox`, which runs the logic that
needs neither React Native nor UIKit through `ios/HotUpdater/Package.swift`. `HotUpdaterSandboxMarker.m` holds the literal the
CLI looks for in a built app, and stays.

`HotUpdaterSandboxCoordinator` owns a channel switch and knows nothing of the
screen: the screen observes `HotUpdaterSandboxState` and calls its actions.

`HotUpdaterSandboxDevOverride.m` holds a dev session's view of main's
`HotUpdaterImpl`, on what the bridge and a host call: the bundle, and everything
that reads or writes the normal selection. `HotUpdaterSandboxDevState` says what
it serves, for this process only. Connecting stops watching a launch of the normal
selection already prepared, and a crash marker a dev process left is dropped at the
next start.

`HotUpdaterSandboxShelf` keeps a copy of each bundle a switch downloaded, in the
caches directory, and only when the bundle ID ends in `.sandbox`, so nothing stays
in a store app that shares the sandbox's ID. A row starts a stored session through
the same override: `HotUpdaterSandboxDevState` then serves the stored bundle, its
ID, base URL and manifest, on a channel without releases, for this process only.

`HotUpdaterSandboxScreen` renders `HotUpdaterSandboxHomeModel`, which holds its
words and has no views, so its specs read them. `HotUpdaterSandboxDevServer` is all
the screen knows of dev-server mode. The screen is SwiftUI from iOS 16
(`HotUpdaterSandboxViews`, on `HotUpdaterSandboxDesign`), drawn from
`SANDBOX_DESIGN.md` at the package root in the repository, the design Android's Compose screen shares; before
iOS 16 it's a plain UIKit screen. `HotUpdaterSandboxFonts` holds Geist as bytes,
so no resource reaches a normal build, with the license it ships under, which
Info shows: regenerate it from a geist-font release's TTFs with base64.
