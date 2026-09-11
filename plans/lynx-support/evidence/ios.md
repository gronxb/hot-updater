# iOS native feasibility evidence

Status: G1 private native host implemented; 44 real Release simulator scenario
launches passed on the final binary. This is local artifact and startup evidence, not OTA acceptance.

## Native build provenance

- Worktree: `/Users/gronxb/workspace/hot-updater-lynx`.
- Sparkling production template/source: `c4ce8d25c5ea277e13752d68ff1f2a66f5704240`.
- App identifier: `com.hotupdater.lynxexample`.
- Simulator: iPhone 16, `0368C5D9-63CF-447E-B6BB-0E3184B1CD0A`, iOS 26.4.
- Xcode 26.4.1 (`17E202`), CocoaPods 1.16.2, `cocoapods-lynx-library` 3.9.0.
- Locked pods: Lynx, LynxBase, LynxService/API 3.9.0; PrimJS 3.8.0-alpha.6;
  Sparkling, SparklingMacro, SparklingMethod and Sparkling-Router 2.1.0-rc.12;
  SDWebImage 5.15.5, WebPCoder 0.11.0, SnapKit 5.7.1, Mantle 2.2.0, libwebp 1.5.0.
- Complete dependency resolution: `examples/lynx/ios/Podfile.lock`.
- Tested v2 executable SHA-256:
  `4b7124a21bf3588645045085af2adb88bf755ebf40c60c76edda01f11c3bc827`.
- v2 runtime identity:
  `sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-spike-v2`.
- Earlier v1 executable SHA-256:
  `444ccd6d3afb3bd4716fdbeca71938a5aabb34655efeb474d52a8c265f9947a9`.

The declared runtime identity is maintained in Swift and the private staging
scripts. Engine/PrimJS, resource mapping, bridge and application-native-module
contract changes require an explicit identity update; it is not an inferred ABI
hash. The recovery journal and incompatibility cache additionally use the actual
executable hash, so state is scoped to the installed binary.

Sparkling-Router 2.1.0-rc.12 was unavailable from the CocoaPods CDN. `bootstrap.sh`
uses an ignored checkout at the exact upstream commit for all Sparkling pods,
without replacing native components with mocks. Xcode 26.4 rejects Lynx's GNU
array designators under upstream `-Werror`; the Podfile downgrades only
`-Wc99-designator` for the Lynx target. No upstream runtime source was patched.
Template demo screens and unrelated test targets were removed from this host.
Sparkling source license attribution is preserved in the example's notices.

## Reproduction and raw evidence

From `examples/lynx/ios`, after the root workspace and frozen framework fixtures
have been built:

```sh
./bootstrap.sh
node prepare-fixtures.mjs react vue octane --variant=external2-managed
xcodebuild -workspace SparklingGo.xcworkspace -scheme SparklingGo \
  -configuration Release -sdk iphonesimulator \
  -destination 'id=0368C5D9-63CF-447E-B6BB-0E3184B1CD0A' \
  -derivedDataPath .build CODE_SIGNING_ALLOWED=NO build
agent-device install com.hotupdater.lynxexample \
  "$(pwd)/.build/Build/Products/Release-iphonesimulator/SparklingGo.app" \
  --platform ios --udid 0368C5D9-63CF-447E-B6BB-0E3184B1CD0A --session lynx-ios
node run-g1-probes.mjs 0368C5D9-63CF-447E-B6BB-0E3184B1CD0A baseline
node run-g1-probes.mjs 0368C5D9-63CF-447E-B6BB-0E3184B1CD0A recovery
node run-g1-probes.mjs 0368C5D9-63CF-447E-B6BB-0E3184B1CD0A contexts
node run-g1-probes.mjs 0368C5D9-63CF-447E-B6BB-0E3184B1CD0A metadata
node run-g1-probes.mjs 0368C5D9-63CF-447E-B6BB-0E3184B1CD0A failures
node run-g1-probes.mjs 0368C5D9-63CF-447E-B6BB-0E3184B1CD0A capacity
```

Commands run through installed `agent-device` 0.20.10, pinned to the reserved
simulator. Its current CLI lacks the skill's `ensure-simulator` command; the
already-booted target was selected by UDID. `install` requires an absolute app
path. No other device or simulator was used.

Logs:

- `/tmp/hot-updater-lynx-ios-pods-final.log`.
- `/tmp/hot-updater-lynx-ios-build-v2-final.log` (successful Release build).
- `/tmp/hot-updater-lynx-ios-final-baseline.log`.
- `/tmp/hot-updater-lynx-ios-final-recovery.log`.
- `/tmp/hot-updater-lynx-ios-final-contexts.log`.
- `/tmp/hot-updater-lynx-ios-final-metadata.log`.
- `/tmp/hot-updater-lynx-ios-final-failures.log`.
- `/tmp/hot-updater-lynx-ios-final-capacity.log`.
- Each native process appends `events.jsonl` in its app sandbox's
  `Library/Application Support/HotUpdaterLynxSpike`.
- Detailed event, journal and accessibility snapshots under the ignored
  `examples/lynx/ios/.probe-results/1789101733980-baseline`,
  `1789101762985-recovery`, and `1789101777314-contexts` directories.
  Baseline includes six screenshots, all visually inspected. Final negative-case
  snapshots are in `1789101791716-metadata`, `1789101823642-failures`, and
  `1789101839340-capacity` under the same directory.

The probe scripts use unique native scopes, preserve immutable staged UUID
artifacts, and terminate the process before writing a selection. B placement is
manual setup through a trusted local receipt, not an installer implementation.

## Framework and resource results

All six baseline scenarios used the same installed v2 executable without
reinstallation. Confirmed B was then restarted without a fresh trial, and A was
selected again with its regular font restored in each framework. A was embedded in the binary; B came from the sandbox. Each
framework's source was compiled by its real pinned compiler/runtime pipeline.

| Framework  | Embedded A | Local B | Native callback transport | Managed image, external JS, font | Durable confirmation |
| ---------- | ---------- | ------- | ------------------------- | -------------------------------- | -------------------- |
| ReactLynx  | Pass       | Pass    | Pass                      | Pass                             | Pass                 |
| VueLynx    | Pass       | Pass    | Pass                      | Pass                             | Pass                 |
| OctaneLynx | Pass       | Pass    | Pass                      | Pass                             | Pass                 |

The native loader read entry bytes and each same-name resource from the selected
root. A rendered a blue image and Inter-Regular; B rendered a red image and
Inter-Black. Actual `CGFont` decode identified those PostScript names, and the
font was visibly rendered. Each app called native `getLaunchInfo`, received the
intentional error from `probeError`, evaluated its actual external JS marker,
and called `notifyReady`. Native first-content and verified essential resources
were all observed before the one durable confirmation; the journal's pending
field was absent afterward.

| Framework / variant | Bundle ID                              | Entry SHA-256                                                      |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| React A             | `01a08ebd-5388-7e35-a8ae-a4f9f91a6615` | `becb4210f6d9138d18cf8992847b0215e8841a5f0cfc2e6e4e988c616d4ba720` |
| React B             | `01a08ec5-f87a-7a82-8193-0e8ebe19bc8f` | `6991f207e71b4aa349bc2c84adc0f8f9ac783d12cc481099c7007d0043294601` |
| Vue A               | `01a08ebd-5435-75e9-a3c0-b61de2632fc0` | `70baff1f553bd47df086c377778353fee990d85e05421cbe680140bd0db2eb62` |
| Vue B               | `01a08ec6-2396-78e0-8782-c1a68d3a1f91` | `842060055506c22717daac91e5cda7a090405ab0283cd2c5dec1e6cce7eb0065` |
| Octane A            | `01a08ebd-550d-77d6-91a3-42935f7cbac8` | `02dd2d6918122877721abbcdc92b9d38a4a2a1605150641c3b59ff01b03bbe89` |
| Octane B            | `01a08ec6-45ae-7838-a937-15ad91f1c7c5` | `d8ec5097e252ea97b8ef51d44e526ca4fb56b83bc3da6e9f0c7df38a433177d3` |

Resource hashes are identical across frameworks for each variant:

| Resource              | A SHA-256                                                          | B SHA-256                                                          |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `assets/probe.png`    | `fc91145f783ebed0066f6d0a47694d35965da77642b399bc2bd6664c571bba37` | `ddbb03e67984640053adda69030d90f0cdacd85ec1bf5c6a2088d58788cd2761` |
| `assets/probe.ttf`    | `1b08e7fc267a5c7e1d614100f604b83e7e8a0be241f0f288faa2b3ac93a683ba` | `68be2a10f64af792a4b1feaecb07e0d0363a6252290bc2c4de9f4cde5de13397` |
| `assets/bootstrap.js` | `7a937f6b1fa5c142f71dc69a0a1172d02287a7eb3bc0729452e68cecda48872b` | `6f8c6757ab388f6d11fe21828fc5bb6b609b7909e5bdb96569298b4f7d5680b2` |

The custom `hot-updater:///` resource prefix is emitted by compiler configuration;
opaque output bytes are not rewritten. Sparkling routes template, external JS,
font and image requests to the private `SPKResourceLoaderProtocol` implementation.
The loader restricts reads to verified manifest entries in its pinned root,
rejects symlinks and rechecks each hash at read time. No managed URL falls back to
HTTP, app assets, or another release. These assertions concern this host's managed
resource paths, not all operating-system networking.

### Preserved failures and profile boundaries

The earlier v1 `resources-managed` fixtures proved React's actual async native
template loading. Vue and Octane rendered and loaded images, but framework-native
`import()` failed with `loadLazyBundle is not a function`; neither was confirmed.
Those failures are retained in `/tmp/hot-updater-lynx-ios-baseline-events.jsonl`,
`/tmp/hot-updater-lynx-ios-baseline-results.json`, and the earlier screenshots.
The supported core external-JS result does not establish support for these
framework-native asynchronous template APIs.

The first `external-managed` attempt also failed on the real runtime: generic
minification changed the official wrapper's object-returning IIFE into a Boolean
completion value. Lynx's actual `_$executeInit` consumes the evaluated object's
`init` property. Frozen `external2-managed` uses the official wrapper and genuine
TypeScript/SWC compilation with minimization disabled. Its native success does
not rely on a JavaScript global shim or a replacement evaluator.

The first font fixture mounted text before font registration and produced no
native font read. Corrected fixtures mount text after registration. The initial
v1 readiness gate could confirm before the font loaded; v2 explicitly requires
the native verified essential resource set. These earlier results are not counted
as font or complete-startup acceptance.

## Durable recovery and native context results

The journal writes a temporary file, synchronizes it, atomically renames it, and
synchronizes the containing directory. A trial is persisted before primary Lynx
evaluation. Confirmation atomically sets the confirmed receipt and clears pending.
The process owns one designated primary object; neither JS-provided IDs nor a
second native context can replace its pending attempt. Embedded and already
confirmed launches do not consume another trial slot.

Verified on v2:

- Confirm A, launch actual no-ready B, terminate, launch actual no-ready C,
  terminate: both B and C Release IDs survive as separate exclusions. The previous
  A receipt remains confirmed and is rendered as fallback. Crashed-Bundle history
  remains empty.
- Re-select old B: refused before evaluation. Assign a fresh Release ID to the
  same staged B bytes: a fresh pending attempt is recorded, while old exclusions
  remain. Its later unconfirmed termination adds a third exclusion.
- Two real `notifyReady` calls: two accepted observations, one durable confirmation.
- A secondary request before primary evaluation is deferred. An actual later
  second Lynx view renders, but its first-content callback is ignored and its
  readiness call rejected by native object identity.
- A second native primary request is rejected; exactly one pending attempt is
  recorded and confirmed.
- Open the native host without a primary Lynx view: no attempt or resource read.
- Delay processing an actual native readiness call, remove the primary controller,
  then observe Sparkling's real view-deinitializer notification: the queued call
  is rejected. Pending remains; next process records an unconfirmed exclusion.

## Rejection, failure and capacity results

The final binary passed all of the following scenarios:

- Runtime mismatch rejects before candidate evaluation, preserves A, and is
  refused on an identical binary/scope/Bundle/manifest cache key on the next
  launch. Boolean, missing and unsupported schema values, wrong OS, and missing runtime
  identity reject. Corrected metadata changes
  the manifest identity and admits the candidate. No crash or unconfirmed
  exclusion is created by incompatibility.
- A deliberately invalid but manifest-verified native template reaches the real
  Lynx decoder failure. It enters crashed-Bundle history; a fresh Release with
  those same bytes is still suppressed. Repeated native error callbacks are
  coalesced into one startup failure.
- An external JS file physically present inside the selected directory but
  omitted from the verified manifest is refused by the loader before evaluation.
- A real unhandled background exception has `LynxError.isFatal == false`. It does
  not enter crashed-Bundle history; termination before readiness becomes a
  Release exclusion on the next process.
- A stale local selection revision is refused. With 128 test-seeded Release
  exclusions, a new candidate is refused and confirmed A renders; all exclusions
  remain. This seeds bounded state in an isolated scope and does not claim 128
  actual termination runs. A separately test-seeded 128-entry incompatibility
  cache also refuses new candidates, retains all keys, and renders confirmed A.
  Production prepared-install invalidation is G3 work.

## Remaining integration evidence

No OS-offline claim is made. Agent-device's iOS network-status settings change the
status bar and do not disable transport; they were not used as evidence. No global
Mac network setting was changed. The verified local loader has no network fallback,
but delivery-origin-unavailable and full OTA offline scenarios remain later work.

Archive extraction, configured signature verification, native OTA installation,
server-authorized selection, production runtime-ID management, catalog cache
invalidation, server-side no-redownload behavior and OTA end-to-end tests remain
outside this manual G1 host. The scoped local manifest receipt is a deliberate
G1 trust anchor, not proof of authenticated server delivery.

## G2 verified archive preparation and private HTTP integration

This section adds native artifact evidence without changing the preserved G1
results. It does **not** assert public catalog-controller authorization: the
private `--artifact-url` harness consumes an explicitly trusted QA receipt and
uses an internal native finalization seam. Public SDK/controller integration
remains a separate acceptance step.

The package now owns an RN-free artifact installer under `packages/lynx/ios`,
with the adapted archive/crypto source boundaries and original hashes documented
in `packages/lynx/ios/ADAPTATION.md`. Existing React Native native sources,
dependencies and CocoaPods setup are unchanged. The new example CocoaPod resolves
`@hot-updater/lynx/package.json` through Node package resolution. CocoaPods installed
18 declared dependencies / 16 pods, including `HotUpdaterLynxArtifact`.

The native installer downloads through a per-preparation ephemeral URLSession,
verifies the full archive, strictly extracts ZIP/TAR.GZ/TAR.BR into private staging,
validates the manifest and Lynx sidecar, then retains an opaque preparation token.
A trusted finalizer holds the native authority lock while invoking atomic immutable
publication and recording the next selection. Preparation leaves running/next
selection untouched. A process-wide store lease excludes simultaneous owners and
allows a later owner to reclaim abandoned staging. Every managed path is confined,
manifest-covered and hashed. Configured signing verifies the archive and each
asset signature; a supplied manifest token follows the same signing policy. A null
manifest token uses the mandatory verified archive as its trust anchor.

Adversarial review found a PAX range/overflow trap and unbounded metadata allocation.
The Lynx adaptation now rejects malformed PAX lengths before arithmetic/slicing,
limits ZIP count/name parsing before collection, fixes the native platform to iOS,
and rejects blank native runtime identity. It bounds manifests to 16 MiB and
sidecars to 16 KiB before allocation and rejects duplicate JSON keys and depth
above 32. The unchanged RN extraction suite passed 13 tests, including all three
300 MiB archive formats (`/tmp/hot-updater-rn-archive-regression-lynx.log`).

The Swift package test run passed 14 tests, comprising seven catalog-policy tests
and seven installer/configuration tests. The installer tests use the actual local
CLI artifact service, signed ZIP/TAR.GZ/TAR.BR receipts, 35 malformed HTTP fixtures,
revoked publication, repeated/concurrent preparation, exclusive store ownership,
abandoned stage cleanup, interrupted HTTP bodies and cancellation. Exact-boundary
assertions ensure the new PAX/metadata/ZIP tests reach their intended validation.
The log is `/tmp/hot-updater-lynx-installer-tests8.log`; run with
`LYNX_ARTIFACT_TEST_ORIGIN=http://127.0.0.1:18791` and the task-owned public-key path
in `LYNX_ARTIFACT_TEST_PUBLIC_KEY`. Synthetic negatives are never catalog rows.

The actual Release simulator build succeeded after correcting its new CocoaPod
Compression linkage to `libcompression`. Build log:
`/tmp/hot-updater-lynx-ios-build-artifact3.log`. Executable SHA-256:
`58dc6579d936ae074070ee709da691f8600495cea19fdfcbe3a31bb577700938`.
This binary retains the private `ios-spike-v2` profile and is preserved separately
in ignored `.g2-preserved/SparklingGo.app`; the original final G1 binary remains
in `.g1-preserved/SparklingGo.app`.

On that unchanged binary, `run-artifact-probes.mjs` passed **23 actual simulator
launches**. ReactLynx, VueLynx and OctaneLynx each downloaded a real CLI ZIP from
`127.0.0.1:18791`, prepared/staged B while A remained running, and then restarted
into installed B. The native loader read image, font and external JavaScript from
the installed immutable tree; B's readiness completed and its font decoded.
Signed React ZIP, TAR.GZ and TAR.BR repeated the same successful flow. All six B
screenshots were visually inspected: the red B image and Black font rendered.
Configured signing rejected an unsigned archive; revocation after preparation
preserved A; killing the actual process after preparation left private staging,
which the new exclusive owner cleaned on restart without changing A.

Receipts/logs/screenshots:
`examples/lynx/ios/.probe-results/1789104494320-artifact/`, with
`/tmp/hot-updater-lynx-ios-artifact-probes1.log`. This proves real HTTP delivery,
verification, immutable preparation/publication and local resource loading. It
neither simulates OS airplane mode nor proves the final public catalog flow.

The private HTTP capability fixtures subsequently passed on that same binary for
all three frameworks (`.probe-results/1789104623847-http`). Their screenshots show
the actual `/health` HTTP 200 service response and runtime capabilities:
lexical `fetch` is a function, `globalThis.fetch` is undefined, `AbortController`
is a function, and `NativeModules.LynxFetchModule` is an object. This verifies the
lexical-fetch path used by the public SDK; no global fetch shim was introduced.

## Public SDK1 catalog-to-restart path

The first public SDK integration passed for ReactLynx, VueLynx and OctaneLynx on
one unchanged Release executable:
`ebde32e28cf90954549139cd3b5489c04d0bb584bc6382e0fc324b6ad5e71075`.
The native profile is `sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v1`.
The binary is preserved in ignored `.public-v1-preserved/SparklingGo.app`; build
log `/tmp/hot-updater-lynx-ios-build-public2.log`.

`run-public-probes.mjs` drives the real public SDK's Check update and Install next
launch controls through agent-device. It does not write candidate files or native
selection receipts. All three use their existing `ota-<framework>` catalog and
artifact HTTP routes on the actual local CLI provider. Check downloads and
verifies B while the durable next selection remains null and the published
bundles directory remains empty. Install publishes the immutable tree and stages
its authorized Release while A remains running/confirmed. After closing/reopening
the process, B loads and public `notifyAppReady` confirms the native pending
attempt. The B image is loaded from the installed tree.

The native embedded A artifacts were produced by the real Lynx build plugin and
CLI manifest builder, then bound to the approved NIL builtin/minimum identity in
native-only embedding receipts. No catalog A row was synthesized. The native
manifest digest, binary identity, runtime profile and channel participate in the
native storage scope. Catalog acceptance retains its parsed projection and scoped
high-water record; stage rechecks its guard and native-selected receipt while the
controller lock covers artifact publication and durable next-selection storage.

Results: `.probe-results/1789105985870-public-sdk1/` and
`/tmp/hot-updater-lynx-ios-public-sdk1.log`. Exact confirmed Release IDs:
React `01a08edf-f8d1-7033-b08c-f07c7d83be0e`,
Vue `01a08edf-f933-73a8-936b-b9c3a3135155`,
Octane `01a08edf-f959-7101-8c49-7a6b324adbc2`.
SDK1 intentionally includes main template and image only. Full-resource and
recovery acceptance continues in a newer immutable SDK/native profile. The iOS
host did not reproduce Android's missing `String.prototype.normalize`; the shared
follow-up contract nevertheless uses a native canonical `channelKey` and a new
`ios-ota-v2` profile.
