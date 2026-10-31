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
