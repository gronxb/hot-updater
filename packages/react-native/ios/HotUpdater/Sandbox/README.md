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
