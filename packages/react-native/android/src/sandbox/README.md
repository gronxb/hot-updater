# Sandbox layer (Android)

Compiled only into a build whose `nativeBuild.android` scheme sets
`sandbox: true`: `android/build.gradle` attaches `java`, `res`, and
`proguard-rules.pro` only with `-PhotUpdaterSandbox=<scheme>`, which only the CLI
passes.

Add files under `java` and `res`. Nothing outside this directory may refer to
them. `HotUpdaterSandboxMarker.kt` holds the literal the CLI looks for in a built
app, and stays.
