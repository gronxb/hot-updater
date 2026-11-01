# Sandbox layer (Android)

Compiled only into a build whose `nativeBuild.android` scheme sets
`sandbox: true`: `android/build.gradle` attaches `java`, `res`, and
`proguard-rules.pro` only with `-PhotUpdaterSandbox=<scheme>`, which only the CLI
passes.

Add files under `java` and `res`. Nothing outside this directory may refer to
them, except `src/sandboxTest`, whose `attach.init.gradle` runs their unit tests
with `-PhotUpdaterSandbox=test`. `HotUpdaterSandboxMarker.kt` holds the literal the CLI looks for in a built
app, and stays.

`HotUpdaterSandboxCoordinator` owns a channel switch and knows nothing of the
screen: the screen observes `HotUpdaterSandboxState` and calls its actions.

`hot-updater-sandbox.gradle`, which only `-PhotUpdaterSandbox` applies, compiles a
generated `HotUpdaterImpl` in place of the packaged one. It comes from the source
this build packages, by `HotUpdaterSandboxImplGenerator.groovy`, which refuses a
source whose structure it doesn't recognize. Its lines call `HotUpdaterSandboxDev`,
and every one holds for main only.

A dev session is a process: `HotUpdaterSandboxDev` settles once, before anything
reads a bundle, whether this one runs a session. Connecting, a reload and Exit
start a new process through `HotUpdaterSandboxRelaunchActivity`, whose helper
process being alive is what tells a relaunch from an icon tap.
