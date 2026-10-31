# Sandbox layer (iOS)

Compiled only into a build whose `nativeBuild.ios` scheme sets `sandbox: true`.

`HotUpdater.podspec` sets `EXCLUDED_SOURCE_FILE_NAMES = HotUpdaterSandbox*`, and
only the CLI's build xcconfig sets `INCLUDED_SOURCE_FILE_NAMES` back. A build
without it, such as one from Xcode, leaves these files out.

Add a file here with a name that starts with `HotUpdaterSandbox`. Nothing outside
this directory may refer to it. `HotUpdaterSandboxMarker.m` holds the literal the
CLI looks for in a built app, and stays.
