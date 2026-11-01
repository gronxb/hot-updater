# Sandbox layer (iOS)

Compiled only into a build whose `nativeBuild.ios` scheme sets `sandbox: true`.

`HotUpdater.podspec` sets `EXCLUDED_SOURCE_FILE_NAMES = HotUpdaterSandbox*`, and
only the CLI's build xcconfig sets `INCLUDED_SOURCE_FILE_NAMES` back. A build
without it, such as one from Xcode, leaves these files out.

Add a file here with a name that starts with `HotUpdaterSandbox`. Nothing outside
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
