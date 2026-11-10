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

A stored session is the same kind of process. `HotUpdaterSandboxShelf` keeps a copy
of each bundle a switch downloaded in the `.sandbox` app's cache directory, and a
row's claim names one. The generated impl then answers `getBundleId`, `getBaseURL`
and `getManifest` from it, on a channel without releases, and its active state
names the release the claim carries, with no catalog, so JavaScript's
`getBundleId()` reports it.

`HotUpdaterSandboxScreen` renders `HotUpdaterSandboxHomeModel`, which holds its
words and has no views, so its specs read them. `HotUpdaterSandboxDevServer` is all
the screen knows of dev-server mode. The screen is Compose, with the primitives in
`HotUpdaterSandboxDesign.kt` and no Material library, drawn from
`SANDBOX_DESIGN.md` at the package root in the repository, the design iOS's SwiftUI screen shares. Only
`hot-updater-sandbox.gradle` and the guarded lines of `build.gradle` bring in
Compose, its compiler, and `androidx.window`; `res/font` holds Geist, and
`res/raw` the license it ships under, which Info shows.
