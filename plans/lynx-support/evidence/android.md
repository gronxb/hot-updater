# Android G1 native feasibility evidence

Status: native A/B resource, bridge, startup recovery and context scenarios passed
within the private G1 boundary described below. This is a private feasibility host, not an
OTA installer or a claim that G3 passed. All observations below come from the
release APK on the reserved emulator, not a JavaScript mock or a compile result.

## Reproducible native profile

- Worktree: `/Users/gronxb/workspace/hot-updater-lynx`.
- Source: `examples/lynx/android`, adapted from Sparkling template commit
  `c4ce8d25c5ea277e13752d68ff1f2a66f5704240`.
- Package: `com.hotupdater.lynxexample`; release variant, not debuggable, locally
  signed with the Android development key. No development server was running.
- Device: `emulator-5558`, Pixel 10 Pro XL 3, arm64-v8a, 16 KB page size,
  production system image (`adb root` unavailable).
- Toolchain: JDK 17, AGP 7.4.2, Kotlin 1.8.10, Gradle 8.2, SDK 34.
- Resolved runtime: Sparkling 2.1.0-rc.12, Lynx 3.9.0, PrimJS
  3.8.0-alpha.6, Fresco 2.3.0, OkHttp 4.9.0. The complete resolved dependency
  report is `/tmp/hot-updater-lynx-android-final-deps.log`.
- Provisional native profile:
  `android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-spike1`.
  The application owns this value. Engine/PrimJS, loader behavior, bridge API
  and native module ABI changes invalidate it; producer metadata only declares
  a compatible profile and cannot discover an undeclared native ABI change.
- The native journal additionally scopes itself by the SHA-256 of the installed
  APK. A different native binary cannot inherit confirmations, exclusions or
  incompatibility cache entries from the previous binary.

## Build and runtime integration findings

The published Sparkling AAR transitively selected Lynx 3.6.0 and PrimJS 3.6.1,
although the pinned source template described newer versions. Explicit native
version pins are required. `javap` also showed the published `SparklingContext`
lacks the source checkout's `lynxViewCreatedListener` hook. The working host uses
public `LynxViewBuilder` resource hooks with Sparkling's public
`SimpleLynxKitView` constructor, before engine creation and evaluation.

The resource contract is `hot-updater:///` for compiler-emitted managed URLs.
An initial `asset:///` fixture decoded its native template and called the real
module, but Fresco interpreted the image URL as an APK asset, bypassing the
release redirect. The image failed and readiness was correctly withheld.
Changing the compiler's public asset prefix, preserving the old output, fixed
this. No compiled template bytes were rewritten.

Every managed path must be in the authenticated manifest allowlist. Relative
traversal, symlinks, missing paths and unlisted files are rejected. Templates use
`LynxTemplateResourceFetcher`; images use `LynxMediaResourceFetcher` and are
redirected to the immutable installation's absolute file URI before Fresco
caching; external JavaScript uses `LynxGenericResourceFetcher`; fonts use
`LynxFontFaceLoader.Loader` and `Typeface.createFromFile`. The native font loader
records the actual loaded bytes. The SDK's font registration callback alone
proved insufficient: readiness now also waits for native font loading when the
fixture requires the font. The SDK emits nonfatal font format error 302 before
falling back to the public custom font loader; the actual fallback loads and
renders the expected release font.

Fresco 2.3.0's native-memory path failed on the 16 KB emulator. The public
`MemoryChunkType.BUFFER_MEMORY` option permits the real PNG decode. The app still
uses the operating system's 16 KB compatibility mode for pinned dependencies;
production native-library alignment is not established by this spike.
Some later React startup probes also emitted nonfatal image code 301 from an
initial custom-scheme request before the redirected image load succeeded. Their
app-level image load gate still completed. The nine baseline matrix logs did
not contain this image error; the startup logs preserve it rather than treating
all SDK diagnostics as fatal or claiming a warning-free integration.

AGP's default asset ignore pattern silently omitted an Octane-generated
`async/__/.../lazy.ts.<hash>.bundle` from the APK. The authenticated manifest
caught the missing file before evaluation. Setting `ignoreAssetsPattern = ""`
was then checked with that exact frozen Octane font fixture: all six managed
files, including the nested underscore path, survived `mergeReleaseAssets` with
identical hashes. See `/tmp/lynx-android-underscore-merge.log`. The working
external-module APK independently passed a ZIP-level comparison of every
embedded manifest asset (six per framework).

React's framework-generated native lazy template loaded through the template
hook. Vue and Octane's corresponding generated chunks requested an unavailable
`loadLazyBundle` runtime API and failed on the pinned runtime. They are not
claimed as supported. The separate successful cross-framework probe compiles a
real TypeScript module with Rspack/SWC, uses the official Lynx runtime wrapper,
and calls core `lynx.requireModuleAsync`. An initial minimizer discarded the
wrapper's completion value, causing an actual core load failure after the
correct JS bytes were fetched. The corrected `external2` fixture preserves the
official returning wrapper by disabling standalone module minimization. It
executes without an engine shim, `eval` workaround or guessed entry name.

## Actual three-framework A/B matrix

APK SHA-256 for all nine matrix runs:
`8d20e3a4d72a2102ac721436d96b4ca65608308edcf4249df461d5a48b58c97b`.

| Framework  | Embedded A Bundle ID                   | Staged B Bundle ID                     | Staged B Release ID                    | Native result                               |
| ---------- | -------------------------------------- | -------------------------------------- | -------------------------------------- | ------------------------------------------- |
| ReactLynx  | `01a08eb3-f602-7156-88ce-c3193b224d6b` | `01a08eb4-7c2b-7c70-acde-8fa2d2075780` | `01a08eb4-7c2c-7c67-8b83-0a7ba6c4820c` | A, B and offline confirmed B restart passed |
| VueLynx    | `01a08eb3-f64d-79fb-a41f-af106c61ce0d` | `01a08eb3-1838-711f-a85f-1e9348734d4d` | `01a08eb3-1839-733d-8e59-3e0e92234d9f` | A, B and offline confirmed B restart passed |
| OctaneLynx | `01a08eb3-f695-70c7-bf7e-4cb1cc6fe135` | `01a08eb4-9950-7227-a0cf-83bacb666481` | `01a08eb4-9951-7494-aea3-d82108008e9e` | A, B and offline confirmed B restart passed |

Each run fetched the native template, image, external JS and actual font from
its selected release, called native launch information and the intentional
asynchronous error callback, observed native first content, then received the
app's readiness signal after the external JS marker matched its release. Native
confirmation was persisted with synchronous `SharedPreferences.commit()` before
replying. Repeated confirmed B starts logged `confirmed-resume-before-evaluation`
and did not create another candidate attempt.

The same resource names and font family (`ReleaseProbe`) were used in A and B:

| Resource              | A SHA-256                                                          | B SHA-256                                                          |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `assets/probe.png`    | `fc91145f783ebed0066f6d0a47694d35965da77642b399bc2bd6664c571bba37` | `ddbb03e67984640053adda69030d90f0cdacd85ec1bf5c6a2088d58788cd2761` |
| `assets/probe.ttf`    | `1b08e7fc267a5c7e1d614100f604b83e7e8a0be241f0f288faa2b3ac93a683ba` | `68be2a10f64af792a4b1feaecb07e0d0363a6252290bc2c4de9f4cde5de13397` |
| `assets/bootstrap.js` | `7a937f6b1fa5c142f71dc69a0a1172d02287a7eb3bc0729452e68cecda48872b` | `6f8c6757ab388f6d11fe21828fc5bb6b609b7909e5bdb96569298b4f7d5680b2` |

Native logs: `/tmp/lynx-android-{react,vue,octane}-{A,B}-external2.log` and
`/tmp/lynx-android-{react,vue,octane}-external2-resume.log`. Actual screenshots
`/tmp/lynx-android-{react,vue,octane}-B-external2.png` were visually inspected;
each shows Bundle B, its red image, the bold release font and app-ready status.

All nine runs occurred with airplane mode enabled on the reserved emulator.
The negative control `adb -s emulator-5558 shell ping -c1 -W2 1.1.1.1` returned
`connect: Network is unreachable`; the route table was empty. This establishes
offline local loading, not network download or catalog behavior. After all
scenarios, the reserved emulator's original airplane-mode value of 0 was
restored and verified; the original release APK and confirmed React B remained
installed. No other emulator was changed.

## Startup, admission and failure scenarios

The journal and process-guard scenario APK has SHA-256
`05d7ea9cb01a81a1cb49d3f201258accb0cb3b8042a19221231187d610056f87`.
It contains the same frozen embedded external2 files. React B was confirmed
again within this binary's fresh journal scope before negative tests.

- Authenticated incompatible runtime metadata was rejected before any attempt
  or candidate execution. The identical second check hit the compatibility
  cache before any candidate file copy or verification. A default restart still
  loaded the previously confirmed B, with no recovery/failure entry created.
  Logs: `/tmp/lynx-android-compatibility-{first,repeat,confirmed-resume}.log`.
- Authenticated metadata with string `"1"` as its schema was rejected before
  evaluation. The native parser requires a numeric schema version of 1 and
  actual nonempty strings for identity, platform, entry and runtime fields.
  Log: `/tmp/lynx-android-string-schema-rejected.log`.
- A process that never opened the primary context created no attempt. An early
  secondary context was rejected before evaluation. The next normal primary
  resumed the confirmed B without an invented failure. Logs:
  `/tmp/lynx-android-{no-primary,secondary-before-primary,after-unopened-primary}.log`.

- Real React U (B bytes with readiness withheld) and C launches completed image,
  font and external-module bootstrap without confirmation. Their successive
  unknown exits produced separate durable Release exclusions. Re-requesting
  either old Release selected the confirmed B; C did not erase U's exclusion.
  A fresh Release `853248e1-b861-47b5-8920-fcb63e27f9ab` referencing the same
  cached U Bundle `01a08eb5-54ff-76c6-a511-b5c5c42395ab` created a fresh pending
  attempt, without inherited readiness. Logs:
  `/tmp/lynx-android-unknown-{U,C,U-again,C-again,U-fresh-release}.log`.
- While that fresh U attempt remained pending, a second normal Activity was
  launched with Android flags `0x18000000`. The native PID remained 22217, the
  second primary was rejected, and the log contained exactly one attempt.
  A process-level primary guard and `begin`'s pending-record guard prevent
  replacement even when the release directory is identical. Log:
  `/tmp/lynx-android-process-second-primary.log`.
- The real double-ready fixture called `notifyReady` twice, received both native
  successes and rendered app-ready status. The native journal logged exactly
  one confirmation. Log `/tmp/lynx-android-double-ready.log`; visually inspected
  screenshot `/tmp/lynx-android-double-ready.png`.
- The real JS readiness call was delayed 15 seconds using a private native
  intent parameter. An `android.intent.action.VIEW` launch followed by
  `agent-device back --system` destroyed the Lynx context. A native-only
  `noPrimary` Activity kept the same process active; the delayed callback then
  logged `stale-context-rejected`, with no confirmation. PID 23257, attempt
  `582923d4-930b-49fd-b8a9-495b3c2517e0`. Log:
  `/tmp/lynx-android-late-ready-retry-destroyed.log`. An earlier attempt let the
  process become cached after Back; Android suspended its timer, so that run
  proves destruction but is not counted as a delivered stale callback.
- The compiler-generated async throw fixture produced engine code 201,
  `fatal=false` (an unhandled Promise rejection). Its next startup was correctly
  treated as an unconfirmed exit. Log `/tmp/lynx-android-fatal-async.log`.
  A separate intentional negative fixture contained a malformed native template
  with a correctly recomputed authenticated manifest. Native decode produced
  `fatal=true`, code 102 and `onLoadFailed`. Recovery recorded its Bundle in
  `crashedBundles` and resumed the confirmed B. A new Release referencing that
  same fatal Bundle remained suppressed. Logs:
  `/tmp/lynx-android-fatal-{decoder,decoder-recovery,cached-fresh-release}.log`.
  This negative fixture is deliberately corrupted test input, not a successful
  compiler output or a simulated native decoder.
- An image physically present in the staged directory but omitted from the
  authenticated manifest was rejected by the runtime allowlist. No readiness
  occurred; the verified managed-resource failure was recorded and the next
  process recovered to confirmed B. The failed URI stayed inside the selected
  installation and could not load the embedded A image or a network image.
  Logs `/tmp/lynx-android-managed-unlisted-image{,-recovery}.log`.
- Changing only the authenticated manifest serialization and digest for an
  already rejected Bundle caused a fresh verification and incompatibility
  rejection, not a stale cache hit. No asset bytes changed. The confirmed
  selection remained intact. Logs:
  `/tmp/lynx-android-compatibility-new-token{,-resume}.log`.
- Native binary cache invalidation was tested by changing only the release
  version name, producing APK
  `4f536198732021b9f9fe22d38790ea2594679d7703ba433e316c4c6003be2cb6`.
  The same previously rejected Bundle and trusted manifest were verified again
  and rejected, without a cache hit. The original source and exact saved APK
  `05d7ea9cb01a81a1cb49d3f201258accb0cb3b8042a19221231187d610056f87`
  were restored. That binary recovered its existing rejection cache and
  confirmed B selection. Logs:
  `/tmp/lynx-android-compatibility-{new-binary,restored-binary}.log` and
  `/tmp/lynx-android-restored-binary-confirmed-B.log`.
- The final guard binary also reran B successfully for React, Vue and Octane,
  including all managed resource and readiness gates. Logs:
  `/tmp/lynx-android-{react,vue,octane}-final-B.log`.

The private journal reserves capacity before a new candidate: 128 combined
unconfirmed Release exclusions and fatal Bundle entries. These records are
never evicted; at capacity only an eligible confirmed or embedded selection can
start. The 128-entry exhaustion boundary has not been device-stress-tested.
Compatibility rejections are a separate 128-entry optional LRU cache,
keyed by native binary/profile, fixture scope, Bundle ID and trusted manifest
hash. A cache eviction cannot remove startup exclusions. No claim that this
manual staging probe avoided a real network download is made.

## Commands and trust boundary

Run from the worktree, using JDK 17:

```sh
JAVA_HOME=/Users/gronxb/.local/share/mise/installs/java/temurin-17 \
  examples/lynx/android/gradlew -p examples/lynx/android :app:assembleRelease
node scripts/lynx-g1-stage.mjs \
  --source examples/lynx/.hot-updater/g1/react/B-external2-managed \
  --output /tmp/lynx-staged --entry main.lynx.bundle --platform android \
  --runtime-id android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-spike1 \
  > /tmp/lynx-receipt.json
node examples/lynx/android/scripts/stage-fixture.mjs \
  /tmp/lynx-receipt.json react B-external2 emulator-5558
```

Install the resulting APK using `agent-device install`, then launch its package
with `agent-device open --relaunch`. Native intent arguments carry `framework`,
`release` (the private staging slot), and the receipt's `releaseId`, `bundleId`
and `manifestFileHash`; the driver does not grant JavaScript these authorities.
The private staging content provider writes internal files and requires the
shell's `android.permission.DUMP`. It is intentionally excluded from a future
production integration. Shell-owned external files were tried and failed the
application's access check on this production emulator, so they are not the
working staging mechanism.

Build logs are `/tmp/hot-updater-lynx-android-external2-build.log` and
`/tmp/hot-updater-lynx-android-final-g1-build.log`. Stage receipts retain original
file hashes under `/tmp/lynx-android-<framework>-<A|B>-external2.json`.

The host does not implement catalog authorization, network download, archive
extraction, signatures, patching, cleanup or a production secondary-container
lifecycle. G1 manual placement and native journal tests do not establish any of
those G3 behaviors. Public package implementation must preserve these concrete
resource, context and persistence constraints.

## G2 native archive installation and security probes

These probes exercised the real Android artifact library through a shell-only
native activity. They did not authorize catalog selections or evaluate the
installed candidate. The public five-method controller is a subsequent gate.
The RN package remained unchanged; narrowly adapted RN-free archive/download/
crypto leaves reside in the Lynx package under distinct namespaces. The bundled
Brotli decoder was bytecode-relocated to `com.hotupdater.lynx.vendor.brotli.dec`;
its SHA-256 is
`3ddbb1a4c66cf57a879873f1238b62b8ba0ba9bf0ff545452402dbb92ca893e2`.

Release build and native unit tests passed with JDK 17. The build required
explicit `includeSubdomains="false"` on the task-local cleartext origins. AGP
7.4.2 lint also emitted Kotlin metadata diagnostics for Okio 3.6/Kotlin 1.9;
these did not fail compilation or the completed release build. No lint checks
were disabled. The library archive/policy tests passed; the root-generated
catalog vector file is declared as a Gradle test input.

The final unsigned probe APK was `/tmp/lynx-android-g2-lease.apk`, SHA-256
`865b390d6df5e96093866eefe4f64776d2831e49780ba0dc7aac360173c53e15`.
The native signing variant was `/tmp/lynx-android-g2-signed.apk`, SHA-256
`3dc6ad9386f6666e55a065d4a0feca0a09dc050fda360c6337111a74d1ab8bf7`.
Both retained the private spike runtime profile. Native signing configuration
came from a build flag and an embedded public key, never from a JS request.
The private key remained in the CLI fixture process.

On `emulator-5558`, task-owned ADB reverse mappings for ports 18791 and 18792
preserved the real provider URLs. The real CLI ZIP artifacts for React, Vue and
Octane, and React TAR.GZ, downloaded over HTTP, verified their whole-archive
hash, extracted, verified the contained manifest and metadata, and published
immutable directories. All standard artifact responses had
`manifestFileHash: null`; the verified archive authenticated the contained
manifest. Native logs:

- `/tmp/lynx-android-g2-react-zip.log`: Bundle
  `01a08ed4-97d0-7d13-a1a6-311f63f92265`.
- `/tmp/lynx-android-g2-vue-concurrent.log`: Bundle
  `01a08ed4-97d0-7a45-9b59-ed70e313a7ef`; two concurrent preparations converged
  on one immutable installation.
- `/tmp/lynx-android-g2-octane-zip.log`: Bundle
  `01a08ed4-97d1-7617-bdd7-4f0ed233e7fe`.
- `/tmp/lynx-android-g2-react-targz.log`: Bundle
  `01a08ed5-ae54-7f1e-a29d-54c63e5017c1`.

The native authority callback held its test authority lock through the
installer's publication operation. Revoking that authority after preparation
rejected finalization and preserved installed files. This proves the artifact
transaction seam; it does not substitute for the later catalog controller.

Actual cancellation and interruption scenarios passed:

- `/tmp/lynx-android-g2-cancel-job-fixed.log`: an actual coroutine `Job.cancel`
  stopped a slow HTTP response at 15,048 of 80,252 bytes, leaving zero private
  preparations and unchanged installed files.
- `/tmp/lynx-android-g2-cancel-handoff-fixed.log`: the verified result's return
  dispatch was held in a native queue, canceled before the caller received its
  token, then resumed. Outer cleanup left zero preparations. The earlier probe
  trace is retained: its inline coroutine start canceled too late and exposed
  an orphan from the test harness. The corrected probe uses a dispatched job.
- `/tmp/lynx-android-g2-truncated.log`: a server response advertised its full
  length then closed halfway; OkHttp rejected the incomplete body.
- `/tmp/lynx-android-g2-stale-authority.log`: the final native authority recheck
  rejected before publication.
- `/tmp/lynx-android-g2-killed-prepared.log`: process 28430 was stopped after
  `PREPARED`, before its delayed commit. Process 28517 observed the same
  installed-tree hash and one orphan preparation. The following installer
  acquired the abandoned OS lease, removed that preparation, and successfully
  downloaded/installed a fresh preparation of the candidate. Existing files
  remained intact. Each live preparation owns an OS file lock so cleanup
  cannot delete another live installer/process's work.

Twelve independently packaged HTTP hostile artifacts had correct outer hashes.
Every case rejected before publication and preserved installed-tree SHA-256
`cdf55bbd7eeff0bb046771be02d8e94ea430df9f4e31a7f19dc8b5d06de91cbf`:
zero-byte entry, runtime mismatch, string schema version, missing sidecar,
manifest asset corruption, unlisted file, path traversal, duplicate ZIP name,
ZIP symlink, missing ZIP end record, duplicate JSON key, and missing TAR end
marker. Exact input receipts/hashes are in `/tmp/lynx-android-bad-archives.json`;
per-case logs are `/tmp/lynx-android-g2-<case>.log`. The zero-entry case recomputed
both manifest and outer hash, exercising native nonempty-entry admission.
A separate incorrect archive hash also rejected. Native/JVM hostile archive
checks cover opaque long/underscore/space paths, TAR links, metadata allocation
limits, excessive entry count, interruption, and filesystem symlink aliases.

With a native configured key, real CLI signed ZIP and TAR.GZ artifacts passed,
including null separate manifest hash. Supplying the real signed manifest token
also passed. An unsigned archive, a bad RSA signature, and a supplied unsigned
manifest token each rejected without installed-tree mutation. Logs:
`/tmp/lynx-android-g2-{signed-zip,signed-targz,signed-manifest,configured-unsigned-archive,bad-signature,unsigned-manifest}.log`.
The verifier retains the existing RSA-SHA256 signature over SHA-256 digest bytes
and checks signed manifest assets when signing is configured.

The bounded recovery journal gap is now tested natively in an isolated seeded
namespace: `/tmp/lynx-android-g2-capacity128.log`. All 128 unknown Release
exclusions remained durable; a new attempt was refused, an eligible confirmed
selection resumed, and another framework selected embedded fallback. No 128-view
engine loop or existing application journal reset was used.

## Additional core runtime resource and HTTP evidence

The unchanged signing probe APK above ran all six React/Vue/Octane A/B
`*-dynamic-managed` fixtures using the private bridge. Each requested the real
managed `dynamic/component.lynx.bundle`, executed its background program, matched
the returned shared-data marker, loaded the differing native font, and reached
durable readiness. A dynamic template SHA-256 was
`2d8771f322c0e78b4f5aefc0e9b34070142202349c648724dd472517d05c2f93`;
B was `073f62184873acdbe01bc7eddd667d0998b5da9da35ef6192a9deada4111efe0`.
Six confirmed traces are in `/tmp/lynx-android-dynamic-matrix.log`, with complete
per-framework logs and staging receipts alongside it. This proves the core
Lynx dynamic-template resource boundary; it does not establish Vue/Octane's
framework-generated async helper or cross-framework UI composition. Nonfatal
font-format code 302 and one Vue initial image code 301 appeared before actual
managed resource success; they were not relabeled or omitted.

The React `A-http-managed` fixture performed a real request to
`http://127.0.0.1:18791/health`. The inspected screenshot
`/tmp/lynx-android-http-capability.png` shows HTTP 200 and the actual
persisted-PGlite service response (PID 66327). Runtime observations were lexical
`fetch=function`, `globalThis.fetch=undefined`, `AbortController=function`, and
native fetch module `object`. The fixture used the actual fetch and signal,
then confirmed through the native bridge. Trace:
`/tmp/lynx-android-http-capability.log`.

The real CLI signed TAR.BR artifact also passed on the unchanged signed probe
APK: Bundle `01a08efd-8a8a-7d24-a9f3-6a9d07a54c52`, manifest SHA-256
`96c373c38df8d9efc86c719d760f1401083b882dc2fb381457821e5565c3dd03`.
The native relocated decoder processed the downloaded archive and verified all
six files with a null separate manifest token. Trace:
`/tmp/lynx-android-g2-signed-tarbr.log`.

## Public SDK1 integration failure and corrected runtime contract

APK `/tmp/lynx-android-sdk1-v2.apk`, SHA-256
`6cd279d03a19c4a6ca17115416d2c73f63bce9070c56308d17dcd57c32d90043`,
contained the public native module and ota-v1 runtime profile. React embedded A
used native NIL identity and manifest SHA-256
`473c06e7a5fe98f5788ceb52aba97eb13088d6b6a65dab36bead2e7a3cea2420`.
The real public `getLaunchInfo` and `notifyAppReady` completed; the native journal
confirmed A. The inspected screenshot `/tmp/lynx-android-sdk1-react-A-v2.png`
shows the public SDK ready screen. Its process log is
`/tmp/lynx-android-sdk1-react-process-A.log`.

Pressing the actual Check update button failed before native preparation with
`TypeError: e.trim().normalize is not a function`. The inspected screenshot
`/tmp/lynx-android-sdk1-react-prepared.png` preserves that failure. The missing
runtime function is used by shared core channel NFC normalization. This run did
not install or activate B. The first host build also exposed Android's
`/data/user/0` versus `/data/data` root alias during strict path verification;
native-owned storage roots were canonicalized before verification.

The revised internal contract adds native `channelKey` to the state snapshot.
Native policy validates NFC and emits canonical unpadded UTF-8 base64url; the SDK
uses that exact key for its route and scope. No global normalization shim or
weakened Unicode validation was added. This contract requires native ota-v2 and
new SDK3 compiler output; earlier SDK1 and SDK2 snapshots remain preserved.

Independent controller review also identified issues that were fixed before
public acceptance: checked file/directory fsync and checked atomic rename replace
Android `AtomicFile.finishWrite` (which can log failures without throwing); native
failure invalidation occurs before main-queue callback delivery; exact verified
manifest digests remain in native artifact records across restart even when the
server manifest token is null; in-flight preparation reservations enforce the
limit before network work; cohort changes retain the same exclusion journal;
and explicit EMBEDDED Releases cannot bypass unknown-attempt capacity. These
source fixes require the following public-native scenario evidence and are not
claimed complete from the earlier G2 installer probes.
