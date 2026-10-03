# Lynx implementation goal and execution ledger

Status: active on 2026-10-03. The English PRD includes the approved Fresco-only
exception. The final full-platform device gate and six-cell matrix remain open. Read the current
[handoff and completion plan](./handoff.md) first. Historical G1/G2 observations
below remain useful evidence but do not establish current acceptance.

## Goal

Execute the [approved PRD](./prd.md) in
`/Volumes/SSD_2TB/workspace/hot-updater-lynx`, branch `codex/lynx-support`, based on
`17d1030a1`. Deliver `@hot-updater/lynx` and `examples/lynx` with framework-independent
Lynx support for ReactLynx, VueLynx and OctaneLynx on iOS and Android.

Complete G1 native feasibility, G2 package/build/deploy integration, and G3 real
OTA acceptance. Every framework/OS case must prove A-to-B activation in an
unchanged release binary, offline managed resources, readiness, safe recovery,
compatibility rejection, and the remaining PRD acceptance scenarios. Preserve
the existing RN integration where shared code changes. G4 remains follow-up
scope. Do not count build-only, mocks or web preview as device OTA evidence.

The original goal covered the researched PRD, initial package/example, real
builds, type checks and scenario validation, with production follow-up work
explicitly documented. That bounded objective is now complete after the native
probes, real CLI archive evidence, and green workspace checks. Its recorded
elapsed time was about 2 hours 34 minutes. An earlier attempt to replace it was
rejected while it was unfinished; it was not marked complete at that point.

A new active goal now names this PRD, worktree and branch explicitly and covers
all G1–G3 acceptance work described above. Completing the original scaffold goal
did not claim production OTA support. The new full-execution goal remains active.

The source checkout at `/Users/gronxb/workspace/hot-updater2` was preserved.
Tracked changes and 25 untracked task files were copied into this worktree;
their existing implementation and test results remain unvalidated against the
approved PRD.

## Gates

| Gate                     | State                                                        | Evidence needed                                                                          |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| G0: PRD review           | Complete                                                     | Explicit user instruction to execute the PRD                                             |
| G1: Native feasibility   | Complete for the packaged host and retained framework probes | Current full-run and matrix receipts remain G3 evidence                                  |
| G2: Package and examples | Implemented; parent Integration green, current run pending   | Preserve exact commit and release boundaries                                             |
| G3: OTA and recovery     | Not complete                                                 | Green 52-scenario agent job and six current matrix receipts on unchanged native binaries |

## Coordination

All remaining work uses this worktree explicitly. Historical spike APIs and
placement probes are retained only as evidence and are not part of the
production integration.

The user's latest instruction supersedes earlier model and delegation notes.
Continue the remaining implementation and verification directly in this task
without subagents.

## Historical G1 evidence matrix

| Framework  | iOS                                                                         | Android                                                                                                |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| ReactLynx  | G1 A/B, image, font, core external JS, bridge and confirmation pass         | G1 A/B, image, font, core external JS, bridge, confirmation and offline restart pass                   |
| VueLynx    | Same core-resource G1 cases pass; generated async-template failure retained | Same core-resource G1 cases pass, including offline restart; generated async-template failure retained |
| OctaneLynx | Same core-resource G1 cases pass; generated async-template failure retained | Same core-resource G1 cases pass, including offline restart; generated async-template failure retained |

Record exact commands, binary/runtime identities, logs and results as work
completes. A missing result remains unverified. Never replace this matrix with
aggregate test counts that do not exercise its scenarios.

## Current implementation checkpoint

The pushed implementation at `f54a3ae47` implements the consolidated PRD contracts:

- `@hot-updater/lynx` targets the Lynx engine and has no React, Vue, or Octane
  runtime dependency. A check authorizes the catalog and performs nonretained
  native compatibility validation; installation prepares and consumes one exact
  selection only when `update.updateBundle()` is called.
- The public client omits manifest, filesystem install-identity, user,
  event-listener, and init-time insights APIs that native cannot implement
  authoritatively. Default `reload()` propagates native errors. A custom reload
  is configured only with `setReloadBehavior("custom", handler)` and a required
  handler; ignored reload-mode and process-restart values are not accepted.
  `isUpdateDownloaded()` derives from native `nextSelection`, not a JS-local
  installation latch.
- Default reload resolves only after all managed runtimes and views have been
  recreated and propagates any native or reconstruction failure. Channel reset
  persists the default scope before recreating that full generation; the JS
  snapshot is cleared in both the success and failure paths.
- Native iOS and Android installers support full archives, raw and Brotli changed
  files, actual BSDIFF application, verified unchanged-file reuse, bounded
  extraction, cancellation, fallback, and durable atomic publication.
- Build plugins now declare every artifact, portable final name,
  `downloadCompression`, and `patchAssetPath`. Common packaging snapshots those
  exact files without following symlinks or inferring an engine from filenames.
  Older ambiguous manifests use complete-archive delivery. Shared bounds are
  128 MiB per archive and artifact, 512 MiB expanded, 1 MiB per signed manifest,
  and 16 KiB per Lynx sidecar. Artifact paths and fingerprint inputs use stable,
  locale-independent ordering.
- The provider-neutral database contract retains at most 24 ordered base patches
  per target, replaces them atomically, and refuses Bundle deletion while a
  Release or another Bundle's patch still references it.
- Serialized `ArtifactInfo` is capped at 528,384 UTF-8 bytes. Changed-file URL
  resolution uses ordered batches of at most 16 concurrent operations. The
  artifact endpoint selects a usable bounded manifest response or verified
  archive fallback, and it can omit corrupt optional patch rows without weakening
  strict administrative Bundle hydration.
- Archive writers normalize entry order and metadata. Promotion validates source
  archive structure, bounds, manifest coverage, and hashes before repackaging.
  Integration-owned fingerprint providers use bounded roots and stable source
  ordering and fail when source identity changes during hashing.
- Rollback cleanup retains shared content-addressed promotion assets. Replacing a
  patch row retains the superseded patch storage object. Future cleanup requires
  atomic proof of ownership and absence of references before deletion.
- React Native/Hermes selection and default native fingerprinting are owned by
  `@hot-updater/react-native`; bare and Rock consume that provider. Expo owns its
  fingerprint discovery. Common packaging, server, and storage paths consume
  explicit integration declarations. The common CLI setup, doctor, conflict,
  signing remediation, and scaffolding policy now use integration hooks; see
  the September 22 neutral-core checkpoint below.
- The optional Sparkling host owns the bridge, all managed resource loaders,
  primary/secondary authority, startup observations, recovery, leases, and
  same-process replacement of every managed runtime and view. Production
  `SparklingGo` and Android `:app` sources contain configuration and packaged
  host wiring only.
- The Android example uses AGP 8.5.2, Gradle 8.7, and Kotlin 2.0.21. The
  approved package-owned Fresco 3.4 adaptation fixes an image-service ABI crash
  found after packaging checks passed. Current builds and all 28 native
  libraries per APK pass alignment checks, and three-framework image/font
  smoke checks pass on a 16 KB device. Full OTA acceptance is still required;
  see [the Android evidence](./evidence/android.md).
- Separate nonproduction iOS and Android matrix targets expose the lifecycle
  controls needed for strict six-cell evidence. The runner requires correlated
  process, generation, context, attempt, release, resource, patch, and transition
  events; it does not infer success from screen text or old logs.
- The Lynx default suite contains 26 scenarios: the shared default list minus
  only `metadata-v1-migration`, plus `sparkling-multipage-ota`. All delta,
  channel, fingerprint, stale-catalog, recovery, and crash-history scenarios
  remain enabled. The delta rollback chain requires real A-to-B and B-to-C
  forward patches and C-to-B and B-to-A reverse patches; archive fallback is not
  accepted as patch evidence.

Current verification includes package and example type checks, Android
Sparkling unit tests, Swift `LynxControllerLocalTests` at 32/32, workspace lint,
429 E2E unit tests in 22 files, 17 focused crash projection/recovery tests, and
green GitHub Integration through `ba25ecd98`. Focused Android
`force-update-auto-reload` and the forward/reverse BSDIFF rollback chain pass.
Full job `job-20260921181047-umah90` improved the best result to 51/52 on
`f54a3ae47`, with iOS at 26/26 and Android at 25/26. Its sole failure was the
final Android `sparkling-multipage-ota` generation: the launch-wide log window
included three already observed font diagnostics after the bounded native
journal had evicted an earlier page generation. Commit `348284787` starts a new
Android log checkpoint after every successful managed-resource validation, so
later checks contain only unverified diagnostics while all native journal gates
remain strict. Its 207 focused recovery/driver E2E unit tests,
package/example type checks, and workspace lint pass. Full job
`job-20260921204853-cw3i89` still gates G3; the current six-cell device run also
remains pending.

The earlier neutral-package source audit found policy coupling in
`ConfigBuilder.ts`, `hotUpdaterConfig.ts`, `init.ts`, `doctor.ts`,
`infra/scaffold.ts`, `keys.ts`, `conflictDetection.ts`, `expoDetection.ts`,
`validateSigningConfig.ts`, and `getDefaultTargetAppVersion.ts`, plus the
React Native metadata helper exported by `@hot-updater/cli-tools`. The September 22 commits below replace these assumptions with integration
hooks and record the neutral-source and RN/Expo regression results.

## Execution observations

- New-worktree `pnpm install --no-frozen-lockfile` completed successfully. Log:
  `/tmp/hot-updater-lynx-worktree-install.log`.
- `pnpm --filter @hot-updater/lynx... build` completed successfully to prepare
  the existing experimental imports. Log:
  `/tmp/hot-updater-lynx-g1-workspace-build.log`. This does not close G1 or G2.
- Private native/module coordination is documented in
  [G1's internal contract](./g1-contract.md). Native build work and real framework
  fixture generation are running with separate ownership.
- `scripts/lynx-g1-stage.mjs` creates immutable local fixture trees and trusted
  manifest-hash receipts. Real React A bytes were staged; managed-file hashes
  and receipt integrity were checked. One comparison detected a producer rebuild
  after an earlier snapshot; that stale snapshot was not represented as the
  current fixture. Native hosts consume immutable staged paths.
- iOS dependency resolution found an unpublished Sparkling pod reference and
  switched to the reviewed upstream source commit. Android found older transitive
  Lynx versions in the published Sparkling artifact and is pinning the required
  runtime explicitly. Each platform's evidence must record its actual resolved
  native profile rather than trusting template declarations.
- Native agents have observed real Release-host execution. Their exact binary
  hashes, fixture receipts and remaining limitations belong in the per-platform
  [iOS](./evidence/ios.md) and [Android](./evidence/android.md) records. These are
  manual-placement G1 results, not completed OTA acceptance.
- VueLynx and OctaneLynx's emitted async templates currently call
  `lynx.loadLazyBundle`, which is absent in their running framework environments.
  The real native failure remains open; successful compilation did not prove
  executable lazy dependencies. Font registration callbacks also do not establish
  native font-byte loading. Framework/native agents are isolating both issues.
- Android's reserved emulator was placed offline and an external-IP ping failed
  with `Network is unreachable`, with no route installed. iOS simulator status-bar
  airplane indicators do not disable networking and are not offline evidence.
- The shared release selector now accepts optional native-held unconfirmed
  Release exclusions across update, current-selection and rollback paths, and
  includes the full canonical set in its selection-context hash. Absent/empty
  exclusions preserve the existing RN hash. Four new scenario tests failed before
  the change and passed afterward. Core type checking/build and the selected core
  plus RN catalog suites passed (33 tests). Regression log:
  `/tmp/hot-updater-lynx-selection-regression.log`.
- The delivery adversary reviewed that bounded selector diff and found no issues.
  It explicitly left native persistence and stale-install guards as integration
  work. The proposed native journal capacity behavior is recorded in the private
  contract and still needs device evidence.
- A read-only native adversary audit identified reusable transport, extraction,
  crypto and catalog-receipt code, plus concrete RN entry/activation/cleanup
  couplings. Its [reuse assessment](./native-reuse.md) guides the later internal
  boundary; it is not a native feasibility pass.
- The current workspace build passed for 27 projects, type checking passed for
  35 projects, and repository lint passed with no warnings or errors. The initial
  lint run found formatting in three pre-existing experimental Lynx files; only
  those files were formatted. Logs: `/tmp/hot-updater-lynx-workspace-build.log`,
  `/tmp/hot-updater-lynx-workspace-types.log`, and
  `/tmp/hot-updater-lynx-workspace-lint.log`. Full unit validation also passed:
  293 files, 2,755 tests. Log: `/tmp/hot-updater-lynx-workspace-tests.log`.
- All six new `*-external-managed` fixtures are immutable and have recorded
  entry/resource hashes. They use real compiled and officially wrapped background
  JavaScript through core `requireModuleAsync`. This separate supported boundary
  does not fix the Vue/Octane framework-generated async-template runtime failure.

## Reconciled G1 results and G2 work

- iOS's final Release simulator executable is
  `4b7124a21bf3588645045085af2adb88bf755ebf40c60c76edda01f11c3bc827`.
  Its final 44 scenarios passed: baseline 12, recovery 7, native contexts 6,
  metadata/cache 9, failure classification 6, and history capacity 4. Native font
  decoding was observed before confirmation. Details and exact run receipts are
  in [iOS evidence](./evidence/ios.md).
- Android's final G1 APK is
  `05d7ea9cb01a81a1cb49d3f201258accb0cb3b8042a19221231187d610056f87`.
  All three frameworks passed A/B resources and offline restart. Native recovery,
  B/C exclusions, fresh authorized retry, fatal-Bundle suppression, duplicate
  primary/ready and destroyed-context guards passed. The binary-scoped cache
  probe restored this exact APK. [Android evidence](./evidence/android.md)
  retains nonfatal font-loader warnings and the emulator memory-buffer setting.
- Android's seeded history-capacity boundary now passes. iOS has no OS-network
  disable evidence: a simulator status-bar override does not establish offline
  operation. Android's actual emulator networking was restored after its probe.
  Android's private host rejects secondary startup; the production shared
  secondary-container lifecycle remains open.
- The design subagent independently reviewed the external-JS substitution. Real
  core `requireModuleAsync` supports the engine-level all-three target, but does
  not discharge generated async-native-template or native dynamic-component
  coverage. Vue/Octane's missing `lynx.loadLazyBundle` remains an upstream
  runtime/toolchain failure, reproduced with embedded files. These resource
  categories remain separate, unresolved evidence obligations. No framework was
  removed from the approved scope.
- The public build adapter remains provisional. It now requires a native-owned
  `runtimeId`, emits versioned manifest-bound metadata, declares the complete
  ordered artifact inventory, and identifies the delta patch asset. Its 27 tests
  pass, including invalid compatibility
  declarations, reserved metadata, symlink escapes, and prior-output retention.
  Package type checking and build also pass.
- Six real prebuilt compiler-output runs passed independent comparison: 30 files
  retain their exact names and bytes, six Bundle IDs are distinct, and every
  sidecar binds the correct Bundle, OS, entry and native compatibility identity.
  Receipt: `/tmp/hot-updater-lynx-real-prebuilt-verification.json`. This proves the
  package adapter, not final CLI archives or device OTA.
- The CLI's explicit artifact path and archive-failure cleanup have 66 passing
  targeted tests. Real ZIP, TAR.GZ and TAR.BR archive tests check bytes, manifest
  hashes and upload content; their synthetic file data is not compiler/native
  evidence. A compiler failure now preserves the previous successful CLI archive.
  Review regressions also cover macOS parent-directory aliases and unsupported
  untyped file policies. Actual compiler output through the built CLI is next.
- Native implementation reuses a bounded set of adapted file-processing leaves
  inside `@hot-updater/lynx`, with source provenance and private native namespaces.
  A source audit of RN CLI 18, 19 and 20 showed that transitive npm packages do
  not automatically register native projects or local podspecs. A proposed
  separate native-core package would therefore require existing RN host setup
  changes. That proposal was withdrawn, and all RN native sources and setup
  files were restored unchanged. The [reuse decision](./native-reuse.md) records
  the explicit duplication tradeoff. Lynx owns metadata admission, immutable
  publication, process selection and startup lifecycle. No public API is frozen
  and no production OTA acceptance is claimed.

- A fresh combined regression run passed 114 tests across the build adapter,
  opaque CLI/archive path and core selector. Log:
  `/tmp/hot-updater-lynx-g2-targeted.log`.
- The task-local service now uses the real standalone repository/client handlers,
  persisted PGlite and filesystem storage. Fourteen real CLI deployments cover
  all six ZIP combinations, the other archive formats, genuine multiple-bundle
  outputs and configured signing. See [packaging evidence](./evidence/packaging.md).
  Root independently downloaded and verified 11 ZIP archives, including two
  signed archives and three multiple-bundle outputs, against the frozen source
  bytes, sidecar, manifest, signature tokens and actual artifact response.
  Independent receipt: `/tmp/hot-updater-lynx-independent-cli-archives.json`.
- The artifact endpoint can return no separate manifest hash. Native always
  verifies the complete archive first, allowing its authenticated contents to
  anchor the enclosed manifest. When a separate manifest token is supplied, the
  existing configured-signature verification policy still applies. No missing
  transport token is fabricated from an untrusted local digest.
- The provisional JS controller has three methods: `getLaunchInfo`,
  `notifyAppReady`, and `checkForUpdate`. A check prepares and verifies native
  files, then returns an `install()` closure for that exact preparation token.
  The bridge has five methods, including separate prepare and commit. Running
  and next-process selections are distinct. The 29 JS unit scenarios, package
  build and type checks pass; real public-module and HTTP capability verification
  remain integration work.
- Shared native policy fixtures contain 28 scenarios generated from the actual
  core selector and context-hash implementation. They exercise next/running
  selection, B/C exclusions, authorized cached-byte retry, fatal suppression,
  predecessor/embedded rollback, cohort/minimum targeting, and complete exclusion
  hashing. Native Swift/Kotlin policy tests consume these expected results.

- The updated JS workspace verification passed: build for 27 projects, types for
  35 projects, lint with zero warnings/errors, and 2,812 tests in 297 files.
  Logs: `/tmp/hot-updater-lynx-g2-workspace-build.log`,
  `/tmp/hot-updater-lynx-g2-workspace-types.log`,
  `/tmp/hot-updater-lynx-g2-workspace-lint.log`, and
  `/tmp/hot-updater-lynx-g2-workspace-tests.log`. Native tests remain separate.
- The shared policy fixture now contains 44 cases, 22 per OS, adding partial
  numeric rollout and denied transitions. Android's 11 policy tests and iOS's
  seven policy tests pass, each consuming all 22 applicable rows and comparing
  all 1,000 numeric cohorts with the core-generated rollout set.
- Independent installer review found an iOS PAX-header range/overflow trap and an
  Android coroutine-cancellation ownership gap. Both owners added fixes and
  reproductions. Android's reviewer rechecked the outer cancellation cleanup and
  OkHttp cancellation hook against actual job-cancel and return-handoff logs;
  both left zero preparations. iOS's parser and allocation-limit fixes passed
  13 Swift tests, including 35 actual HTTP negative variants; independent
  re-review is in progress. These changes leave the RN native sources untouched.
- Public-module profiles are distinct from the private spike profiles:
  `sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v1` and
  `android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v1`.
  Public fixture channels are `ota-react`, `ota-vue`, and `ota-octane`.
  Six SDK1 B artifacts have been deployed with these native-owned declarations.
  SDK1 tests the initial main/image bridge and network path; it does not replace
  full-resource SDK2 acceptance.
- Three immutable HTTP diagnostic fixtures now distinguish lexical `fetch` from
  `globalThis.fetch` and request the actual local service before native launch
  calls. Pinned Lynx source injects lexical `fetch` through its module wrapper;
  actual iOS runs now prove HTTP 200 from the persisted catalog/storage service
  in all three frameworks. Android has the same successful React observation.
  `globalThis.fetch` is absent while lexical `fetch` and `AbortController` work.

## Public-controller integration checkpoint

- The iOS private HTTP installer completed 23 launches on Release executable
  `58dc6579d936ae074070ee709da691f8600495cea19fdfcbe3a31bb577700938`.
  All three frameworks loaded CLI-produced B with image, font and external JS
  after preparation, staging and process restart. Signed ZIP/TAR.GZ/TAR.BR,
  configured-key rejection of unsigned input, revoked finalization and abandoned
  preparation cleanup also passed. This probe uses private receipt authorization;
  it does not establish the public catalog/controller acceptance path.
- Android's native installer accepts the actual CLI ZIP/TAR formats and rejects
  configured signature failures and authenticated malformed archives/metadata,
  including an empty declared entry. Actual coroutine cancellation and truncated
  HTTP responses leave no partial active installation.
- All six Android core dynamic-component fixture runs passed native template
  loading, returned A/B markers, font decoding and durable confirmation. The
  Vue/Octane framework-generated `loadLazyBundle` failure remains separate.
  Full-resource SDK2 fixtures are being prepared to combine these resource
  categories with the public SDK and real delivery service.
- Native embedded/minimum identity for public examples is the core's NIL UUID.
  The embedded metadata and manifest bind that identity, and the trusted native
  manifest digest contributes to state isolation. OTA Bundle IDs remain UUIDv7.
  This avoids generating an embedded minimum newer than already-published B.
- Both native controllers are integrating durable catalog high-water/projection,
  revision-bound preparation tokens and publication under the authority lock.
  Stored-receipt eligibility must retain an eligible staged B when an uninstalled
  newer C appears, while rejecting revoked or excluded B. Native rollback
  provenance is being reconciled with the core's predecessor cohort semantics.
- Package review added the repository license and Android adaptation provenance.
  Independent decoder inspection confirms 15 RN and 15 Lynx JVM classes with no
  class-name intersection; full packaged mixed-host validation remains separate.

## Runtime and package integration findings

- Native signing discovery now has an explicit build-plugin authority mode.
  Lynx's app-owned resolver supplies the native public key; signed deployment
  rejects a missing or mismatched key even when unrelated RN-style native files
  contain a key. Default RN/Expo discovery remains unchanged. Ninety-two focused
  tests and package/CLI builds and types passed. Two actual signed CLI runs with
  real native project paths passed, bringing recorded deployments to 24.
- A clean consumer installed actual `pnpm pack` tarballs for Lynx and its local
  core dependencies. The package contained its native sources, podspec, decoder,
  policy fixtures and license, with no build/cache/private output. ESM/CJS imports
  and controller creation remained inert; the packed build preserved opaque
  files and exposed the native signing resolver. This checkpoint used the earlier
  runtime; the final package will be rechecked after the native/SDK fixes settle.
  Receipt pointer: `/tmp/hot-updater-lynx-packed-current.json`.
- The normal build and Hot Updater build callback now share the public example
  compiler wrapper. Actual React/Vue/Octane builds each produced all six managed
  files plus the adapter's entry metadata. Receipt:
  `/tmp/hot-updater-lynx-public-build-verification.json`. These compiler outputs
  predate the next runtime correction and are not native acceptance fixtures.
- Android's first public SDK1 run confirmed A and exercised the public module,
  but its update check failed before native preparation because the channel
  encoder called unavailable `String.prototype.normalize`. iOS's SDK1 check
  prepared B successfully; the missing method is an Android runtime observation.
  The corrected SDK uses a native-owned canonical `channelKey` for the request
  route and expected catalog scope. Native retains NFC/UTF-8 encoding authority;
  shared core validation is unchanged and no global polyfill was added.
- The internal bridge addition requires new declared native profiles ending in
  `ota-v2`, and a fresh immutable SDK3 fixture revision. Runtime SHA-256 is
  `a1eb27a0a47fdd0c4cefd1eeb588b55fbe30034e1c8bf86f7f59349478d31a52`.
  Its 36 runtime tests include Unicode routing without `String.normalize` and
  invalid native-key rejection before HTTP. SDK1/SDK2 evidence remains intact;
  SDK2 will not be published as a successful Android update.
- Further native adversarial review found durable-write, readiness race,
  restart manifest-binding, EMBEDDED recovery/capacity, cohort history isolation,
  callback isolation and managed fallback defects. Owners have source fixes;
  targeted native fault/race/recovery probes remain required. Cohort participates
  in selection context, not the durable journal namespace: changing it within
  one binary/runtime/channel cannot erase Release exclusions or catalog history.

## 2026-09-22 neutral-core checkpoint

- `0c76a3d71` replaces the common CLI's fixed application build list with
  discoverable `./integration` descriptors. Bare, Rock, Expo, and Lynx declare
  their own setup dependencies and opaque build configuration. Infrastructure
  templates discover these exports and now include Lynx without a common-layer
  framework branch.
- `a18776c50` moves React Native native-wiring diagnosis into
  `@hot-updater/react-native` and Expo conflict/CNG guidance into
  `@hot-updater/expo`. Common commands invoke generic build-integration hooks;
  common signing diagnostics no longer name a framework.
- A mechanical boundary test scans neutral production source, infrastructure
  build scripts, and public package descriptions for RN, Expo, Hermes, Metro,
  Sparkling, `.hbc`, and RN native-wiring policy. It passes. The focused common
  CLI suite passes 521/521, the React Native package suite passes 146/146, and
  the Expo package suite passes 44/44.
- The data decision remains no schema change and no engine discriminator in the
  prerelease 1.0.0 migration. A shared deployed process is permitted only with
  separate `createHotUpdater` instances, routes, database/schema state, API-key
  authorities, and storage namespaces for each logical delivery project.
- The best full-device record remains 51/52. Commit `338c75c3a` fixes the final
  Android evaluator's same-generation sibling-page journal interleaving without
  accepting different-generation or different-provenance evidence; the focused
  evaluator suite passes 49/49. A new exact-HEAD full run is still required.

## 2026-09-28 Fresco compatibility checkpoint

The user approved a Fresco-specific workaround. The package rebuilds pinned
upstream image-service source against Fresco 3.4.0, adapting animation callback
parameters and retaining the upstream license. The example uses Sparkling's
normal pool configuration; no native-memory bypass remains. Source hashing and
the native fingerprint cover the adaptation. All three Android release targets,
production AAB, 31 Sparkling JVM tests, 16 KB ELF/ZIP alignment, and real
React/Vue/Octane image/font/readiness smoke checks pass. React also admits its
separate detail bundle through the actual main-page button.

The latest full job, `job-20260922013654-ku1gwj` on `966236e35`, is terminal
failure. Its automatic lint classification incorrectly matches the installed
`@shadcn/lint` dependency; consult the child logs for the actual failures. No
full job is currently queued. The historical best remains 51/52. The iOS native
back lifecycle experiment remains unproven. Its patch is preserved outside the
worktree as recorded in the handoff; committed iOS source remains in use.

## 2026-09-29 committed Fresco validation and build reproducibility

Commit `6d50f8a49` passes the full workspace unit suite: 3,854 tests in 343
files. The clean Android production scaffold build also passes real main/detail
readiness and Sparkling open/close navigation on the 16 KB emulator; its exact
binary hash is recorded in the Android evidence.

Full job `job-20260928151428-detpgp` on that commit failed before any device
scenario. The ordinary BSDIFF package build recompiled the checked-in WASM with
a different Rust toolchain, changing its bytes and causing the native source
attestation to reject the checkout. Normal package builds now keep the committed
WASM; maintainers explicitly use `build:wasm` when updating its Rust source. The
source-integrity check remains strict. The full device gate must be rerun after
this build fix; historical best remains 51/52.

The shared iOS driver also closed every active `agent-device` session before
launch and back actions, including sessions owned by other device runners.
Cleanup now targets only the current process's session; a device-in-use retry
can still close the exact stale E2E session identified by that device's error.
A regression reproduces the cross-session closure before the fix, and all 61
driver tests pass afterward. BSDIFF asset and runtime tests pass 17/17, with the
committed WASM hash unchanged by the normal package build.

Job `job-20260928152140-ogt541` on `705635434` then passed the strict source
check and Android Release build, but failed before scenarios because iOS
bootstrap selected macOS Ruby 2.6. The native build command now explicitly
selects Ruby 3.3.10, matching the Gemfile lock, without relying on global mise
configuration. Bundler's dependency check passes with global configuration
disabled.

The earlier Android multi-page pending-state failure also has a concrete cause:
the republish endpoint returns a new Release without replacing the original
deployment record used by the metadata wait's default Release lookup. The
scenario now supplies the exact republished Release ID for both interruption
and fatal-transition checks. All metadata waits in this managed-transition
scenario set `relaunchLimit: 0`, so observing staging cannot activate it by
restarting the app. The existing scenario orchestration tests verify the exact
Release and the no-relaunch contract and pass 2/2.

Job `job-20260928153356-xfwoeg` on `3f860ef7c` also failed before scenarios:
pinning the Ruby version did not fix the inherited shell's PATH precedence.
Replaying the running bot's environment reproduces the discrepancy: mise
resolves a directly invoked Ruby to 3.3.10, while a child shell still resolves
`bundle` and `ruby` from `/usr/bin`. The native bootstrap now sets
`MISE_ACTIVATE_AGGRESSIVE=1` for that subprocess only, placing the selected
tools first as documented by [mise](https://mise.jdx.dev/configuration/settings.html#activate_aggressive).
The same environment then selects Ruby 3.3.10 and completes the actual bootstrap,
including Bundler and all 17 CocoaPods dependencies. This build-environment fix
does not count as device scenario acceptance.

## 2026-09-29 iOS navigation lifecycle follow-up

Full job `job-20260928154852-ej3uiq` on `d689f46d6` passes both native Release
builds and has entered device execution. Its scenario result is still pending.

The independent iOS investigation identified two adapter defects. Sparkling
replaces the navigation controller delegate without forwarding `didShow`, so
the adapter now reconciles completed pops from its public container appearance
callback. UIKit's iOS 26 content-pop gesture also needed the visible Sparkling
page delegate while the navigation bar is hidden. The adapter connects that
gesture and enables back gestures only above the root. Synchronous JavaScript
close is guarded against duplicate cancellation from a nested appearance
callback. No application-native code or upstream Sparkling source is patched.

An incremental Release matrix binary with executable SHA-256
`9dcddec3178b952712c25da44b0ef99fed49504a008e87693024929198666f64`
passes actual React main/detail navigation on the dedicated iOS 26.4 simulator.
A completed edge swipe emits one native-back record and reveals main. A short
cancelled gesture on a pending detail preserves that context without a terminal
record; a later completed swipe records exactly one `authorized-cancel` with
reason `nativeBack` and null transition ID. Animated JavaScript close also
returns to main without an extra native-back record. These are targeted local
checks, not the six-cell matrix gate. The full E2E and React matrix detail now
request a nonanimated close to cover its synchronous lifecycle callback.

The agent-device `back --system` XCTest drag did not navigate reliably on the
same binary. Both runners now use its real `gesture swipe right-edge` preset,
which invokes UIKit navigation and passes the targeted device check. Native
event and stack assertions remain unchanged. Focused driver/matrix tests pass
89/89, and fingerprint tests pass 12/12. A clean native receipt and complete
device rerun are still required for this navigation change.

The clean matrix wrapper subsequently succeeds on `66a2df9be`. Its full app tree
SHA-256 is `23f3b68ea8e6523d335a19208394b31211421f0318637a3872c8e2d92ef6b9d5`,
and the installed tree matches exactly. One fresh, unmodified process passes
nonanimated JavaScript close, admitted-page native back, cancelled pending-page
swipe, and completed pending-page native back. Exact native events and artifact
provenance are retained in [the navigation smoke evidence](./evidence/ios-navigation-smoke.json).
The six-cell OTA matrix remains outstanding.

## 2026-09-29 shared E2E startup races

The running `d689f46d6` full job reveals two Android harness failures after native
builds pass. `multi-asset-replacement` sends its first catalog request directly
to the provider's unnamespaced production channel and receives HTTP 404. The
E2E startup code silently fell back to the native provider URL when the control
configuration took more than two seconds. Initialization now waits for a valid
proxy configuration with a bounded request; a failure reports startup error
instead of bypassing the namespace and client authority.

`release-ota-recovery` captured the crash fixture's marker as ready while its
screen status was still `STARTING`. By the time the driver read authoritative
recovery evidence, the actual stable bundle correctly reported a different
marker. Startup now publishes a null marker until confirmation, including on
startup errors. The driver still requires exact agreement with the eventual
ready runtime; no resource-error or native-journal assertion is weakened.

Two regressions reproduce these failures before the fix and pass afterward.
The combined bootstrap, runtime-observation, and driver suites pass 80/80;
example type checks, targeted lint, and formatting also pass. The current full
job does not contain either startup fix or the iOS navigation fix. Its final
result and a new full run on the fixes remain required.

## 2026-09-29 completed baseline and harness corrections

Full job `job-20260928154852-ej3uiq` on `d689f46d6` finishes **46/52**:
iOS 25/26 and Android 21/26. Failures are iOS `sparkling-multipage-ota`, and
Android `multi-asset-replacement`, `release-ota-recovery`,
`republished-crashed-bundle-skipped`, `runtime-channel-crash-restore`, and
`sparkling-multipage-ota`. This does not replace the historical best of 51/52.
The current follow-up, `job-20260928162042-ocwb3m`, resolves its source when it
starts and is building `aa2ade4c3`, including the navigation and startup fixes.

The Android stack failure has independent native evidence: the retained journal
contains all 15 `routeClosed` events, ending at sequence 215 with only
`main.lynx.bundle`. Its stack diagnostic took 28,149 ms, exceeding the E2E
poller's 20-second action timeout. That timeout permanently halted the main
page poller, so the final capture request remained unanswered. The poller now
uses the same bounded 60-second deadline as the driver. A regression reproduces
the 28-second diagnostic and lost subsequent capture before the fix, then
passes afterward; serialization and the explicit hung-action timeout remain.

A clean two-platform public matrix build on `7a3ced5f2` passes source integrity.
Its iOS app tree is `eb92c01b595cedf84f0c04b12ea08c656d4a58117c12897ce3be120a934e73a3`;
its ARM64 device APK is `b68d0f04b594a4fc5dc8a636f2e7c4f870863a4da9d0420744b0ed3cb856b467`.
All 14 packaged ARM64 native libraries are uncompressed and have ELF LOAD
alignment of at least 16 KB; APK ZIP alignment also passes. The dedicated
Android device reports a 16,384-byte page size. The earlier two-ABI packaging
checks remain separate evidence.

That public matrix reaches iOS native stack depth 16 and completes all 15 real
back gestures, but then fails because the retained main page still correctly
shows its runtime-capture status instead of the initial readiness text. The
runner now checks the retained main page identity after diagnostics and rejected
installs, preserving the native readiness, stack, process, generation, and
install-rejection assertions. The six-cell run must be repeated. The combined
poller, public matrix, bootstrap, and driver suites pass 189/189 after these
corrections; example type checks pass.

The common CLI doctor test previously imported RN implementation source into the
CLI TypeScript root. Commit `aa2ade4c3` loads the real integration using the
existing cross-package test convention. All 57 doctor tests, all 35 workspace
type-check projects, and workspace lint pass. The workspace integration suite
is still running and has reported a DynamoDB test timeout and a MySQL setup
timeout; it is not green. The production iOS build was interrupted to commit
these harness corrections with an intact source attestation and must resume.

## 2026-09-29 matrix journal receipt comparison

The clean `5c239fc3d` matrix run reaches the real iOS navigation and journal
diagnostics, then rejects `retention-limit` after reopen. Captured native
diagnostics prove all six installed/appended and reopened receipts have exactly
the same values; only NSDictionary JSON member order differs. The validator now
uses strict structural equality, retaining exact canonical byte/hash and every
metadata comparison. A regression fails before the change and passes afterward;
changed hash, sequence, and process receipts remain rejected. All 36 focused
diagnostics/runner tests pass, and replay of all six captured receipts passes.
Matrix teardown now closes its own agent-device session even on a failed cell.
The six-cell acceptance gate is still open.

The broad integration run finishes with 402 passed, one failed, and ten skipped
tests: DynamoDB's per-test cleanup hook times out, and MySQL setup times out.
A focused two-file retry passes all 63 DynamoDB tests and nine MySQL tests,
leaving the MySQL fumadb patch/deletion serialization test at its 30-second
deadline. It is being investigated separately; integration is not green.

The active full E2E job started native setup on `aa2ade4c3`, but its device shard
worktrees resolve `5c239fc3d`. Preserve that provenance distinction rather than
describing the whole job as a single-source acceptance run. Both native builds
pass; scenario execution remains in progress. The queued follow-up is
`job-20260928164123-6zd6ks`.

## 2026-09-29 real page lifecycle gaps

`job-20260928162042-ocwb3m` finishes 46/52 (iOS 24/26, Android 22/26).
The six failures are iOS `bspatch-manifest-diff-fallback` (30-second simulator
log query timeout) and `sparkling-multipage-ota`, plus Android
`release-ota-recovery`, `crash-then-next-safe-update`,
`republished-crashed-bundle-skipped`, and `sparkling-multipage-ota`.
Historical best remains 51/52. The follow-up job `job-20260928164123-6zd6ks`
was cancelled in setup because it lacked the newly diagnosed fixes.

Captured iOS events 296–322 prove both C pages were rebuilt and admitted with
new contexts, but reconstruction omitted `pageOpened`. The package now emits
the real event after attaching the rebuilt controllers. Android's captured
snapshot stopped at sequence 23 (`firstContent`), while its durable journal
subsequently contained admission at 24 and its terminal receipt at 25. Normal
page cycles now reuse the existing bounded wait for those exact native records.
The regression exercises that delayed admission rather than treating a visible
marker as readiness.

The three Android crash failures share `order.fatal-boundary`: the crash fixture
loaded its custom font and then intentionally failed before confirmation. It
now injects that pre-ready native page failure before optional resource warmup;
the recovered page must still prove full resources and readiness. The strict
font diagnostic validator is unchanged. The crash bootstrap regression fails
before the change and passes afterward. Device recovery remains to be rerun.

The clean `b23299eda` public matrix passes the six journal diagnostics, installs
B, verifies offline B retention and rejects missing/corrupt C detail bytes. It
then reveals that the retained detail page has no `Check update` control.
React, Vue, and Octane detail pages now initialize the public SDK for their own
context and expose checking and installation/reload after admission. Tests
cover admission gating and deliberate unconfirmed fixtures. All three real
compiler builds, 120 focused tests, example type checks, and targeted lint pass.
The matrix failure also confirms its own agent-device session is released.

The remaining MySQL serialization test passes on the next isolated execution
without a code change. Read-only process observations show active schema DDL,
not a stuck transaction. This focused success does not turn the earlier broad
integration run green.

## 2026-09-29 primary-context OTA authority

Commit `972c11e94` passes the full unit suite (3,865 tests in 343 files), all 35
workspace type-check projects, workspace lint, and clean native matrix builds
on both OSes. Full job `job-20260928171631-2fpuk1` uses that same commit for
native setup and all four device shard worktrees; its native builds pass and
scenario execution is in progress.

The matrix run exposes a contract mistake in the new detail controls: native
catalog authorization correctly rejects a secondary context with `STALE_CONTEXT`.
Those controls are removed. Existing native authority remains unchanged. The
primary SDK page now offers `Install with detail open`: it navigates through
Sparkling, waits for the new detail's native admission and durable terminal,
then installs and reloads through the retained primary context. React, Vue, and
Octane use the same flow. The before-reload receipt uses the actual newly opened
detail context; the earlier offline-retention receipt remains distinct.
Regression coverage rejects a stale previous detail terminal as evidence that
the newly opened page is admitted. The 120 matrix regression tests, example
type checks, targeted lint, and all three real compiler builds pass. Device
validation of this flow is pending.

The full workspace integration rerun on `972c11e94` passes **413/413 tests in
28 files** in 687 seconds (`/tmp/lynx-972c11e-workspace-integration.log`). No
database code changed for the preceding transient timeouts.


## 2026-09-29 iOS fingerprint refresh

Full job `job-20260928171631-2fpuk1` rejects the iOS fingerprint install at
deploy time: the committed fingerprint still describes the Sparkling host
before the reconstructed-page event fix. The normal fingerprint command
reproduces exactly that native-file difference. Regenerate `fingerprint.json`
and both configured iOS plist hashes through `hot-updater fingerprint create`;
Android's hash remains unchanged. Rebuild native binaries before device
acceptance. This keeps native compatibility validation strict.


## 2026-09-29 delayed native detail close evidence

The same full job's iOS multi-page scenario fails after B's native back: the
first JS journal capture ends at sequence 276 (`pageAdmitted`), while a
read-only capture of the durable native journal contains the matching actual
`nativeBack` at 277 with only main remaining. The retained evidence is
`evidence/ios-detail-close-race.json`. Native navigation succeeds; the test
observes before the animation/lifecycle callback completes.

All single-detail close/back paths now wait within the existing bounded
20-attempt policy for the exact context and final native stack evidence.
Pending-page cancellation still requires its own matching durable terminal.
The regression supplies a stale previous-page close and delays the current
page's event; both back and JavaScript-close cases fail before the fix and pass
afterward. The related driver, scenario, and evidence suites pass **72/72**.
Native source and fingerprint are unchanged by this harness correction.


## 2026-09-29 SDK sample viewport

The clean `c4a9985a5` matrix reaches verified C preparation in the retained B
primary. Its captured accessibility tree places `Install with detail open` at
y=845 inside a Lynx viewport ending at y=840; the accessibility backend still
labels the action hittable. The tap does not reach the SDK and no navigation
occurs. This is sample layout and driver targeting, not secondary authority.

React, Vue, and Octane SDK pages now use compact spacing and a 64 px resource
image, retaining ordinary 46 px action targets. Production pages are unchanged.
The driver rejects action centers outside any ancestor's visible rectangle
even when accessibility reports hittable. The captured geometry reproduces
the false acceptance before the fix. All 121 matrix tests, example type checks,
and three actual compiler builds pass; device verification is still required.


## 2026-09-29 full-run result and reconstructed-page diagnostic

Full job `job-20260928171631-2fpuk1` finishes **49/52** on one commit
(`972c11e94`): iOS 24/26 and Android 25/26. Its iOS failures are the stale
fingerprint and early close observation, already corrected. Android completes
forward and reverse multi-page deltas, pending close/back, and then fails the
pre-confirmation interruption fixture because the reconstructed detail was
admitted instead of held pending.

The native journal proves old-page cancellation at 408 and accepted transition
at 409, followed by new detail admission at 443/444 and primary confirmation
at 445. `replaceGeneration` cleared the unconsumed one-shot next-page diagnostic
before reconstructing that page. Preserve this forward diagnostic until the
next secondary page consumes it; old-page progress observers still clear, and
closing the host still clears all observers. The existing shared scenario is
the device regression. Evidence is in
`evidence/android-reconstructed-pending-diagnostic.json`.

Refresh Android's fingerprint and all three configured manifest values with
the normal CLI; fingerprint verification matches. Sparkling JVM tests pass
31/31. Running the diagnostics suite also exposes an earlier extra class-closing
brace that prevented its last restore test from compiling. Remove that brace;
all six diagnostics JVM tests pass, including restoring the live journal.

## 2026-09-29 selection refresh after page admission

The compact SDK layout reaches real B detail navigation. The next matrix
failure is a stale selection authorization: opening/admitting the page changes
the native state captured by the earlier catalog selection. A scoped device
inspection returns to primary and observes `Release catalog selection became
stale before it was committed`. Primary JavaScript did execute the operation;
this is not evidence of a paused background runtime. The sample now rechecks
after durable detail admission, requires the same selected Release, and then
installs/reloads through the primary. Native stale-selection checks remain
unchanged. The regression forbids reusing the pre-navigation installer and
requires a second catalog check. It fails before the change; all 121 matrix
tests, example types, and three real compiler builds pass afterward.

The complete workspace unit suite on `d3cbbd6f9` passes **3,866/3,866 tests
in 343 files**, and workspace lint passes. Fresh native builds, a new full
shared E2E job, and the six-cell public matrix remain required.


## 2026-09-29 reconstructed readiness observation

The clean `26b23ee18` matrix builds both native targets and actually replaces B
main and detail with C in iOS process `91162`. C generation
`A11A8535-5381-43D5-8F04-52633C322371` has distinct new contexts, all six page
resources, detail admission and a confirmed `UPDATE_APPLIED`. The runner still
times out because its readiness predicate only accepts a one-page initial
stack. The collector also incorrectly infers reconstruction from initial
context count; Android declares the retained two-page logical stack before its
secondary Activity attaches.

Share exact stack/context validation between the predicate and collector.
iOS requires both declared contexts; Android may start with its primary, but
must subsequently prove the matching native route, distinct secondary identity,
resources, admission and durable terminal. Negative tests reject mismatched
contexts, parameters, missing resources and missing readiness. Both platform
regressions fail before the change and pass afterward. Replaying the captured
iOS C journal also passes the full collector. This is evidence for that phase,
not a completed public matrix cell.

Preserving the next-page pending diagnostic exposes a related harness deadlock:
primary native confirmation correctly waits for the pending secondary, while
JavaScript previously waited for confirmation before starting diagnostic polling.
Start diagnostic polling after configuration and resources, with confirmation
already requested. The ready marker still waits for native approval. The
regression proves diagnostics remain responsive with a pending confirmation and
no ready marker. Five focused evidence/startup suites pass 52/52; the complete Lynx E2E unit
project passes 460/460 in 22 files, including real compiler builds. Example types
and targeted lint pass. The earlier full verify command was stopped while
waiting for PR checks, before any new job was queued. Rebuild and rerun both
acceptance gates on the committed changes.


## 2026-09-29 repeated diagnostic journal restoration

The `ca366bcb6` matrix passes C reconstruction/readiness and reaches its next
native journal checkpoint. The external ledger correctly rejects changed bytes
for sequence 1. Captured snapshots show 82 live events before native diagnostics,
zero afterward, and a new sequence 1 from B at the C checkpoint. The iOS matrix
explicitly restores to inspect the receipt, then restores again in deferred
cleanup. With no remaining backup, the second call replaced the journal with an
empty envelope. Evidence: `evidence/ios-diagnostic-double-restore.json`.

Restoration now does nothing when no fixture backup is pending, and clears the
backup only after successful restoration. The iOS regression preserves exact
bytes through explicit/deferred cleanup, appends the next live event and reopens
the file; it fails on the original implementation. The corresponding Android
API has the same destructive repeated-call behavior, reproduced by extending its
existing live-journal restore test. Correct both diagnostic implementations;
production journal semantics and strict external-ledger checks are unchanged.
Swift journal tests pass 22/22 and Android diagnostics pass 6/6. The normal CLI
refreshes the iOS fingerprint and both plist values; Android is unchanged because
its diagnostics are excluded from the production fingerprint. Rebuild the matrix. Full shared job `job-20260928181940-4izq1i` remains on
`ca366bcb6`; no results from the later fix may be attributed to that job.


## 2026-09-29 common CLI CocoaPods dependency

A production dependency walk exposes `hot-updater -> apple-helper ->
@hot-updater/react-native`. The Apple helper also discovers RN and injects RN
CocoaPods flags into an unrelated Podfile. A dependency-closure regression and
plain/Bundler Podfile tests fail on that implementation.

Add the optional integration-owned `getPodInstallEnvironment` hook and pass its
result through native iOS build/run to CocoaPods. Bare, Rock and Expo obtain RN
prebuilt defaults from `@hot-updater/react-native`; explicit environment overrides
remain intact. The common Apple helper drops its RN dependency and performs no
RN discovery. Fifteen focused dependency, Podfile, command and RN policy tests
pass. The workspace build passes all 27 projects and types pass all 35 projects.

The matrix retry on `7eb4f9e03` proves live journal preservation (82 events before
diagnostics, 219 afterward). It then stops during C deployment because a local
package-link refresh removed the old Apple helper's RN dependency before its
compiled output was rebuilt. This run is not an OTA runtime failure or completed
matrix cell. Finish rebuilding tools and rerun against a committed checkout.
Full shared job `job-20260928181940-4izq1i` uses separate worktrees pinned to
`ca366bcb6` and is unaffected by those local dependency edits. Its first two
Android scenarios time out waiting for a ready marker; native snapshots retain
confirmed generations, but `adb` diagnostics also time out under host load over
130. The cause is not yet established; retain the strict readiness checks.

The real packed-install fixture subsequently exposes a separate optional-peer
leak: the server root exports Kysely Insights helpers and makes CLI `--help`
require Kysely. Move those exports to the existing Kysely adapter entrypoint and
update the Postgres consumer. A subprocess regression blocks all optional ORM
drivers and fails before the fix. Rebuilding all 27 projects passes, and an
isolated installation of ten production tarballs runs CLI help with neither RN,
Expo, nor Kysely installed. Six focused suites pass 36/36. The first workspace
unit run passes 3,887/3,888; its sole failure assumes common CLI Expo validation.
Split that test into scaffold-without-config-execution and actual selected-Expo
doctor checks; both pass. Final workspace units/types/lint are rerun after these
changes; full onboarding/deployment proof remains outstanding.

## 2026-09-29 explicit app-data deletion evidence boundary

Full job `job-20260928181940-4izq1i` finishes iOS at 25/26. Its last multipage
failure is `capture reset embedded A: overlapping native event 1 changed bytes`.
The scenario explicitly calls `/e2e/reset-local-app-state`; the control server
deletes the full Lynx data directory, including the native journal. The driver
incorrectly keeps the prior lifetime's external ledger for the new journal.
This is distinct from diagnostic double restoration fixed in `7eb4f9e03`.

Archive the prior receipt only after a successful explicit app-data deletion and
include every archived receipt in final evidence. Start a fresh ledger for the
new data lifetime. Do not reset on ordinary controls, failed deletion, relaunch,
reload or diagnostic cleanup. The reproducing test fails on changed event 1;
67/67 driver and ledger tests pass after the fix, including failure and corruption
checks. Native runtime behavior and within-lifetime byte comparisons are unchanged.

The completed full job is **46/52**: iOS 25/26 and Android 21/26. Retain all
scenario outcomes in `evidence/shared-e2e-ca366bcb6.json`. The final Android
multipage failure reads iOS's `unconfirmedReleaseIds`/`crashedBundleIds` names
from Android state. Direct device inspection finds the expected Release exactly
once in `unconfirmed`; `crashed` is absent, meaning empty in the Android store.
Map the raw stored exclusions by OS, keeping absent Android lists empty and
preserving malformed/duplicate values for strict assertions. Do not use the RN
compatibility crash-history projection for this check. Three focused driver,
ledger and store suites pass 79/79 after both harness corrections.

The common dependency changes pass the full workspace suite: **3,893/3,893 in
348 files**. This run precedes the three new stored-exclusion cases, which pass
in the focused 79-test run. All 27 build projects, 35 type projects and workspace
lint pass. Supabase's exact import-map expectation is updated because its server
entrypoint no longer pulls in the unused optional Kysely peer. Commit and rebuild
before fresh device acceptance; these results do not upgrade the old job's score.

## 2026-09-29 remaining native-helper policy

Fresh full job `job-20260928191114-vsk520` starts from pushed `da5ae4636` after
PR checks pass. Keep heavy local builds separate from its device execution while
investigating the prior four startup timeouts. A read-only observer captures
failure journals, stored exclusions and host load.

The remaining helper audit reproduces Xcode returning `Lynx.framework` instead
of the application when dependency settings appear first. A legitimate app named
`React` is also excluded by the old RN-specific name filter. Prefer the `.app`
product by standard `WRAPPER_EXTENSION`, retaining the prior fallback for
framework-only builds. Both regressions fail before the fix and pass afterward.
Remove the unused Gradle RN-port argument path (neither caller supplied it),
use generic native-tool progress stages and remove the RN codegen TODO from the
common Apple helper. Both helper type projects and focused lint pass. Build the
two changed helper packages after the ongoing native setup; these local changes
are not part of the `da5ae4636` device job.

A follow-up finds the Android launcher implicitly forwarding port 8081 even for
Lynx. Move that default into the RN integration through the optional native-build
`developmentServerPort` field. Bare, Rock and Expo retain 8081, explicit CLI
ports win, and a missing integration default produces no reverse rule. A command
regression fails before the change; selection, forwarding and CocoaPods policy
tests pass 14/14. Rebuild integration packages before running their type and
regression checks because the new field/export is not in the previous dist files.

## 2026-09-29 full-run failure diagnosis on da5ae4636

Full job `job-20260928191114-vsk520` finishes **49/52**: iOS 25/26 and
Android 24/26. All five worktrees used the same pushed commit. The four earlier
Android startup timeouts pass in this run. Native evidence and every scenario
outcome are retained in `evidence/shared-e2e-da5ae4636.json`.

- Android's republished-crash scenario force-relaunched after two seconds,
  before native fatal handling. The captured store contains only an unconfirmed
  Release. The driver now waits for the candidate's actual durable crash list
  entry before recovery; a 60-second deadline fails without forcing a second
  launch. Remove the shared test projection that treated unconfirmed Releases
  as crashed Bundles. A delayed-crash regression fails before the change, and
  both OSes reject interruption-only evidence without relaunching.
- iOS's final lifecycle reset starts on embedded A, whose Bundle identity is
  identical to server A. Native correctly adopts the server Release into the
  confirmed receipt. Require the exact adoption and stable metadata before the
  explicit managed reload, retaining the full generation-transition assertion.
- Android recovery starts the primary context before attaching the retained
  secondary Activity. Accept that initial context count only on Android, while
  requiring the actual route, verified resource, first content, admission,
  exactly ordered stack and durable terminal. Check a declared second context
  against the attached identity and require the reconstructed primary's content
  and readiness. The corrected evaluator passes the unchanged captured journal;
  missing admission and a mismatched declared context still fail.

The three focused reproductions fail before their fixes. The combined driver,
store, multipage evidence and orchestration suites pass **91/91**. Rebuilt
workspace build (27 projects), types (35 projects), and lint pass. Full unit
validation passes **3,908/3,908 in 350 files**. These changes need a fresh pushed
full device run;
they do not convert the failed job into acceptance or close the separate matrix.

## 2026-09-29 isolated CLI deployment and doctor

Full shared job `job-20260928195209-rzyw0v` is queued on pushed `9cbc0c985`.
Another task owns the bot devices; leave that task untouched. No fresh device
outcome is claimed while this job is queued.

An isolated production-tarball installation, without workspace links, completes
key generation, fingerprint creation/checking, app doctor and signed delivery.
RN, the RN integration, Expo and Expo fingerprint are absent. Two PGlite-backed
instances in one loopback server both deploy iOS and Android with the same
production/1.0.0 selectors. All four archives and all 32 asset signatures verify,
as do the retained compiler file hashes and page/resource metadata. Both directions
reject foreign artifact, Release, Bundle and signed-storage reads. Both databases
remain at schema 1.0.0. Retain `evidence/isolated-cli-flow.json`.

The fixture exposes doctor comparing `file:` tarball locations as version strings.
Resolve installed package versions only for non-semver specifiers through the
existing neutral package resolver. Declared semver ranges retain their previous
comparison. Three regressions cover compatible tarballs, incompatible versions
and a missing installation; all fail before the change. The combined doctor and
resolver suites pass 62/62, focused lint and CLI build/types pass, and reinstalling
the rebuilt CLI tarball makes the unchanged local installation pass doctor.
Do not normalize or replace the fixture's dependency specifiers to mask the bug.

This fixture reuses hash-verified compiler output and copied native configuration;
it is not a new compiler/native run, cloud onboarding or public matrix receipt. The queued job has no resolved commit while waiting. Push the tested doctor
fix before it starts and record the actual checkout commit from all job worktrees.

A final 16 KB policy audit removes the obsolete compatibility-dialog dismissal
from the early Android public probe script. The aligned binary requires no
compatibility mode or automated warning bypass; the Fresco exception remains
limited to the package-owned source/ABI adaptation.

A second real server run adds separate client API keys and Hono admin bearer
middleware. Each project receives a signed iOS deployment using the repository's
`commonHeaders` configuration. Both client catalog/artifact and admin requests
reject foreign credentials with 401; own credentials succeed, and a valid other
project token cannot read the original project's Release (404). Signed storage
URLs remain isolated. Credentials stay in private temporary files and are absent
from the retained evidence. Both local fixture servers are stopped after checks.

Final validation passes **3,911/3,911 unit tests in 350 files** with one worker
(333.59 seconds), workspace lint, CLI build/types, and the legacy probe script's
syntax check. The six pre-existing staged helper diffs remain byte-identical.

## 2026-09-29 public matrix authority capture

The full shared job `job-20260928195209-rzyw0v` starts on `a5bb32fb3` after the
queue clears. Read the actual setup/shard HEADs; the original request time and
local log filename do not establish the executed commit. It remains independent
of subsequent local matrix fixes.

The freshly built production iOS scaffold on that commit passes main readiness,
exact resource hashes, two separately compiled detail launches, JavaScript close,
and native back in one process/generation. Diagnostics are absent from the Release
binary. The unconfigured production endpoint means no network OTA claim. Retain
`evidence/production-scaffold-ios-a5bb32fb3.json`; fresh Android production
validation and full/public-matrix acceptance remain separate obligations.

The fresh React/iOS public cell completes real delta delivery and C generation
readiness but times out expecting two retained-authority rejections. Saved native
sequence 321 contains only the primary rejection; the shell captured at initial
startup, before detail creation. The append-only external callback record is
intact, so bounded-journal eviction did not cause this timeout. Keep the failure
receipt and original evidence hashes in `evidence/public-matrix-a5bb32fb3-failure.json`.

Capture diagnostic authorities at the actual generation-retirement boundary on
both OSes and consume that probe once. The same-Release phase now uses the public
SDK to navigate/admit a detail and reload from its retained primary, replacing an
obsolete shell button that only reloaded one page while expecting a nonexistent
`primaryRemoved` event. For a reopened detail, require its predecessor's native
close/back evidence and preserve exact primary identity and retirement membership.
These are nonproduction fixture/collector changes, not native application setup.

New focused regressions fail before the changes and the matrix runner, contract,
and evidence suites pass **131/131** afterward. Missing/reordered/foreign close
records, incorrect retirement membership, missing admission/terminal/resource
events, reused contexts, and secondary authority remain rejection cases. A fresh
native matrix build and actual device run are still required; no complete public
cell is claimed by these unit results.

## 2026-09-29 full-run confirmed fatal action delivery

`job-20260928195209-rzyw0v` completes **50/52**, iOS 25/26 and Android 25/26,
on `a5bb32fb3`. All preceding shared scenarios pass. Both final multipage failures
are `Missing authentic verified detail fatal`. The native journals stop at the
confirmed server-A primary; no detail was created. Stage timing shows a bare
open request followed milliseconds later by evidence capture, while the control
server keeps only one pending action. Capture overwrote navigation before the
application consumed it.

Use the existing `openDetailPage` helper to require the observed detail marker
and parameters before the next command. Then wait for exact confirmed embedded
recovery metadata with `relaunchLimit: 0`. Only afterward capture and apply the
unchanged native fatal, recovered-selection and reconstructed-stack assertions.
The four focused driver, orchestration, evidence and poller suites pass **84/84**.
This changes the scenario's command ordering, not the SDK or the failure criteria.
Retain `evidence/shared-e2e-a5bb32fb3.json` and run a fresh full job.

The `94ad81609` matrix native builds pass on both OSes. Its fresh production
Android Release excludes diagnostics and passes all 14 ARM64 libraries' ELF/ZIP
16 KB alignment. On the 16 KB Android 17 emulator, images/fonts, detail readiness,
and JavaScript close are visible. The system-back screenshot is black despite
the primary Activity being reported resumed; keep that check open for diagnosis.
Do not count this as completed Android scaffold acceptance. The non-root,
non-debuggable production app does not expose its private journal for extraction.


## 2026-09-29 confirmed generation recovery and native action targeting

The full shared job `job-20260928211636-6hdwci` is queued after green PR checks;
its actual checkout commit must be read when it starts. No new shared pass count
is available. The latest completed result remains 50/52 on `a5bb32fb3`.

The fresh `7cc24042b` public matrix completes React/iOS A-to-B offline activation
and B-to-C reconstruction, then stops because the automation matches both a
native button and its container. A manual role-qualified button action on the
unchanged binary produces both expected stale-context rejections. A subsequent
real confirmed-C detail-fatal probe exposes a package error: iOS records the
fatal page, then tries to classify the same failure again through revoked
context authority. The retained native record ends in `terminalPersistenceFailed`
with `STALE_CONTEXT`. See `evidence/public-matrix-7cc24042b-failure.json`.

The host now skips duplicate classification for already-persisted failures and
compares full Bundle/Release identity before reconstructing a fallback. A server
Release for the embedded Bundle can therefore recover to the embedded selection;
a failed embedded selection cannot reopen itself. The controller recognizes a
suppressed confirmed Release as recovery and retains its verified-fatal page
stack from the durable terminal record. This uses existing state fields and adds
no migration. A failing-before native regression distinguishes `RECOVERED` from
an ordinary update. Swift validation executes 137 tests, 13 skipped and zero
failures; the focused matrix suites pass 135/135. The complete workspace passes
3,919/3,919 unit tests in 350 files, all 35 type projects, and lint.

The matrix's old confirmed-failure expectations also conflict with the PRD:
a confirmed interrupted Release has replaced the stored confirmation, and a
verified fatal C must be excluded. The interruption phase now observes embedded
A recovery and explicitly selects eligible C again. The confirmed-C fatal probe
runs after reverse rollbacks, reactivates C through the public SDK, then requires
embedded A reconstruction, durable Release suppression, and Bundle crash history.
It cannot reuse C as the recovered selection. Native action selection specifies
the button role and still rejects multiple actual buttons.

The unchanged Android production `94ad81609` APK subsequently shows three real
detail openings, JavaScript close and two successful system backs with main
image/font content and unchanged PID. Retain the successful recheck separately
from the initial unexplained black screenshot; no app or package workaround was
added. Neither production scaffold smoke claims network OTA with its endpoint
unconfigured. See `evidence/production-scaffold-android-94ad81609-recheck.json`.


## 2026-09-29 compatibility preflight matrix correction

Fresh `d06cb07da` matrix binaries build on both OSes. React/iOS passes real
A-to-B offline activation, B-to-C reconstruction and both stale-authority
rejections. The next phase stops because the runner expects install readiness
for an incompatible runtime. Native correctly rejects it during the authorized
check preflight and records one incompatible-artifact cache entry. The runner
now requires check-time `INCOMPATIBLE` on both attempts. An observed diagnostic
status replaces the first error before the second click, preventing a stale
label from satisfying that wait. Exact archive request counts, unchanged running
generation and no candidate evaluation remain mandatory. No SDK behavior or
native artifact changes in this correction. Retain
`evidence/public-matrix-d06cb07da-failure.json`; complete cells remain zero.


## 2026-09-29 incompatible metadata transport correction

The fresh `ad0734918` React/iOS run reaches check-time `INCOMPATIBLE`, then
waits for a nonexistent second archive request. Server evidence identifies the
only ZIP request as the deployment verifier. Native preflight requests the
from-C delivery representation, manifest and changed runtime metadata instead.
The negative fixture is deliberately metadata-only. The corrected driver
resolves that actual representation before checking, verifies both response
hashes against deployed files, requires exactly one manifest and metadata GET
and no archive GET, then separately observes cached rejection with no further
file requests. Process, generation and no-evaluation assertions remain intact.
Three regressions reject cached metadata downloads, missing manifest reads and
wrong metadata response hashes; all 138 focused tests and targeted lint pass.
No package or native behavior changes. The retained failure is
`evidence/public-matrix-ad0734918-failure.json`. Complete matrix cells remain
zero; the confirmed-fatal host correction still needs its full device phase.

Before the next device run, static review also found that the incompatible
Release remained enabled after its cache assertion. Native incompatibility
caching does not change catalog eligibility, so later fallback-to-C selection
would keep choosing that newer negative fixture. Disable it through the real
admin policy endpoint only after both rejection checks and their evidence
checkpoint. This isolates later phases without changing SDK selection policy
or weakening the rejection/cache proof.


## 2026-09-29 same-Release and cached incompatibility device progress

On fresh `089cf0b11` binaries, React/iOS passes the manifest/metadata negative
fixture and cached no-redownload proof, same-Release full-stack recreation with
both retired C authorities rejected, and pending-page managed transition
cancellation/reconstruction. The next deployment stops before device execution:
`confirmed_interruption` violates ota-deploy's hyphen-only fixture name contract.
Use `confirmed-interruption` for the compiler output name; the evidence role
remains `CONFIRMED_INTERRUPTION`. This changes no native or SDK behavior. Retain
`evidence/public-matrix-089cf0b11-failure.json`; no full cell has completed.


## 2026-09-29 fatal recovery preserves the detail stack

Fresh `ee3b18b62` React/iOS passes confirmed-interruption recovery to embedded A
and reselects C. The actual pre-confirm detail fatal records `runtimeFailed`,
then recreates C with both main and detail ready in the same process. The driver
incorrectly waits for visible main text while the reconstructed detail is on
top. Use the existing reconstructed-detail observer: require complete native
readiness, native back to C main, and its matching route-close event. Do not
open a duplicate detail. Retain `evidence/public-matrix-ee3b18b62-failure.json`;
this is device progress, not a complete matrix cell.


## 2026-09-29 reverse delta UUID identity correction

On `6dc6352db`, React/iOS additionally passes reconstructed C detail readiness
and native back after a pre-confirm fatal, then pre-confirm process interruption
and C recovery. Reverse delta preparation fails before device application because
its matrix-only helper still treats Bundle IDs as 64-character hashes. Use the
shared `isUUIDv7` contract for Bundle IDs; file digests remain SHA-256. Against
the retained real local server and compiler outputs, the corrected helper creates
both C-to-B and B-to-A BSDIFFs and returns manifest delivery with no full archive.
This targeted probe does not claim device application. The probe server was
stopped. Retain `evidence/public-matrix-6dc6352db-failure.json`.

Shared job `job-20260928211636-6hdwci` started and resolved actual commit
`6dc6352db14392126f71c63015ba434bf6c4093a`; its final result is pending. Preserve
that checkout even if subsequent matrix-only corrections advance PR HEAD.


## 2026-09-29 fatal attempt attribution and process-epoch regression

The `1dcf23cf5` React/iOS matrix executes every driver phase, including real
reverse C-to-B-to-A deltas and confirmed-C fatal fallback to embedded A. Final
evidence validation rejects the fatal event's null `pageAttemptId`; its matching
verified-fatal terminal has the actual ID. The iOS lifecycle observer now reads
the real pending ID before classification for both diagnostic and actual errors.
The collector remains strict. Retain `evidence/public-matrix-1dcf23cf5-failure.json`;
this is still zero fully validated cells.

The shared job's native setup uses `6dc6352db`, but its later-created runner
worktrees and deployed JS use `1dcf23cf5`. Those commits have identical native
source; record both rather than treating setup SHA as the whole job's checkout.
The running job exposes two iOS crash-relaunch state-publication failures:
`release-ota-recovery` and `crash-then-next-safe-update`. Both logs reject new
process epoch 1 after an in-process recovery raised the prior epoch. Crash
relaunch now prepares a fresh launch identity through the existing control
endpoint. A changed launch identity resets the server epoch; setting the same
identity retains stale-runtime protection. The new regressions fail before the
fix; all 212 focused tests across five suites pass afterward. Swift executes
137 tests, 13 skipped, zero failures. Device revalidation is still required.

The iOS fingerprint scenario independently catches a stale committed fingerprint
from the earlier native recovery change. Regenerate fingerprint.json and both
iOS plist values after the fatal-attribution change; the CLI fingerprint check
now matches. The new iOS fingerprint is
`ad84b7ed81a63a2a1f954d756f8c3b876281fdb501a4c963efd84630ad1edd42`;
Android is unchanged. Never reuse the earlier native binaries as current proof.
The running shared job is allowed to finish; a subsequent exact-source run is
required for these corrections.


## 2026-09-29 exact resource graph and builtin recovery selection

The `dad654d45` React/iOS run executes all driver phases and collects 775
native events. Final receipt validation rejects the compiler-authored resource
graph: the compiler/normalizer sort main-page resources, while the validator
builds an unsorted expectation. Sort that canonical expectation without changing
its members or page order. A regression feeds the real build normalizer into
the cell validator and fails before the fix. Future validation failures retain
`failed-receipt.json` with `passed: false` and the actual error. This run remains
zero validated cells; see `evidence/public-matrix-dad654d45-failure.json`.

Shared job `job-20260928211636-6hdwci` finishes **45/52**: iOS 20/26 and
Android 25/26. Setup uses `6dc6352db`; runners use `1dcf23cf5`. The fingerprint
failure and four iOS relaunch/epoch failures are addressed in `dad654d45`, but
require a fresh run. Android's final multipage journal proves a verified fatal
and complete builtin reconstruction. The test endpoint nevertheless replaces
explicit `releaseId: null` with the last server Release for the same Bundle.
Infer only an omitted ID, retain null as an exact builtin identity, and include
expected/observed Release IDs in timeout diagnostics. The regression fails
before the correction and retains exact Release matching and RN confirmation
race behavior. Keep `evidence/shared-e2e-6hdwci.json`.

The remaining iOS multipage failure contains 16 admitted pages and no native
back event after its single gesture; the 203-event journal is not truncated.
Do not mask it with relaxed depth assertions or an assumed root cause. Manual
checks on the unchanged `dad654d45` matrix binary on dedicated iOS device
`3A0A8EB7-9381-4CFD-B002-5B16F539D445` observe each native back depth from 15 to
1 after admitting all 16 pages. The shared-app full rerun remains required.
Retained local evidence: `/tmp/lynx-stack-forensic-before-swipe.json`,
`/tmp/lynx-stack-forensic-after-swipe-events.json`, and
`/tmp/lynx-stack-forensic-backs.json`. The device session is closed.

Run a new full shared job and six-cell matrix from one frozen pushed commit.
Historical best stays 51/52; no completed matrix cell is claimed yet. The
Fresco-only exception remains package-owned, checksum-pinned and included in
fingerprinting. No native workaround is added to the scaffold application.

Focused verification after these corrections passes 230/230 tests across seven
suites; targeted formatting/lint and git diff checks pass.

Full workspace verification initially exposes two stale source-layout contracts
after extracting metadata matching. Register the two helper files in the tracked
E2E surface and replace the text-slicing assertion with actual RN/Lynx metadata
matching for a rollback base versus the active staging Bundle. Those 98 harness
contracts pass; the fresh full workspace run then passes **3,928/3,928 tests in
351 files** (`/tmp/lynx-metadata-graph-workspace-green.log`). No scenario is removed.


## 2026-09-29 payload identity and recovery evidence

The `08163b59a` React/iOS run completes all driver phases and retains 775 native
events, but final validation fails at embedded/server A equality. Every one of
the eight installed files is byte-identical. The manifests differ only in
transport metadata (Brotli/download hash and sizes). The normalizer now binds
manifest bytes to the recorded digest, verifies compiler output bytes against
artifact files, and retains all eight payload hashes/sizes for exact A/server-A
comparison. Detail admission retains PAGE_ADMITTED and its own identity, with
no primary jsReadySequence. Regressions reproduce both former rejection paths.

Offline inspection of the complete failed receipt exposes two native issues
before another run: recovered process-interruption events are emitted after
page evaluation, and pre-confirm secondary fatal recovery loses the RECOVERED
source because reportPageFailure clears the pending startup selection. Move
the terminal replay before initial stack construction and leave that startup
selection for recovery to consume, matching primary fatal behavior. A Swift
scenario confirms B, starts C, fails C's detail before primary readiness, then
requires B recovery, C Bundle/Release exclusions and exactly one C-to-B response.
It fails before the correction and passes afterward. Swift executes 138 tests,
13 skipped, zero failures. No final-contract assertion is relaxed; the original
receipt remains failed. Fatal event sequence numbers now use the full event
journal consistently. See `evidence/public-matrix-08163b59a-failure.json`.

Fresh production iOS evidence at `08163b59a` verifies the installed full app
tree, real image/font resources, separate detail contexts, JS close and native
back, with diagnostics absent. This is not network OTA evidence. Android's
original black screenshot is explained by its retained keyguard/display-sleep
state, stopped/nonvisible root activity and absent focus. Unchanged APK timed
back checks show the main page visible by 0.863 seconds and still visible at
6.004 seconds in PID 12016. Keep the original failure, diagnosis and successful
checks separately; no application workaround is warranted. Subsequent native
changes require fresh production iOS proof.

Shared job `job-20260928230647-4uc5ag` remains queued for the pushed `08163b59a`
source while these local corrections are prepared. Do not advance remote HEAD
between its setup and runner checkouts. Latest completed shared result remains
45/52; historical best remains 51/52; complete public matrix cells remain 0/6.

Verification after the payload/recovery corrections: the full workspace passes
**3,933/3,933 tests in 351 files** (`/tmp/lynx-payload-recovery-workspace.log`),
the two focused matrix suites pass **112/112**, and targeted formatting/lint
and diff checks pass. The refreshed iOS fingerprint is
`3cec7835e41b5684ee038ffbe12e7802b3f85aae7199810412b50b23dc57d4c7`;
Android remains unchanged. Six pre-existing staged helpers remain byte-identical.

## 2026-10-03 resume against current next

The user resumed work and requested synchronization with `next` before further
implementation. Fetched `origin/next` at `50a9ccc32` and began a merge into
`codex/lynx-support` from `4926c92fe`. The merge spans 1,680 upstream files and
118 textual conflicts, including the new protocol package, storage engine,
public adapter APIs, and manifest-only delivery. Conflict markers are resolved;
semantic compatibility remains under test. No E2E has been queued yet.

The six staged local helpers were saved in an isolated staged-only stash and a
binary patch before merging; the untracked signing keys remain untouched.
Restore those exact staged bytes after the merge commit. Never include them in
the PR. Local preservation records are
`/tmp/lynx-local-helpers-stash-20261003.oid` and
`/tmp/lynx-preserved-staged-before-next-20261003.patch`.

The current intermediate source builds all 29 workspace projects. Type and unit
checks are running against the merged APIs; this is not a completed merge or an
E2E pass. The public six-cell matrix previously reached React/iOS and Vue/iOS at
`4926c92fe`, before Octane/iOS deployment selected the smaller complete archive.
Those temporary matrix receipts are no longer present after the interruption;
retain that as a historical observation, not a newly replayed acceptance proof.
The durable shared runner logs remain available and record 40 passes plus the
iOS republished-crash failure before user cancellation. The failed recovery
selected builtin instead of the expected previous stable OTA.

## 2026-10-03 next integration checkpoint

Merged source under validation: `origin/next` at `50a9ccc3217b846a557cb4534ceb27cbf7df0aa8`
(101 upstream commits after the previous Lynx head). All text conflicts have
been resolved; manifest-v1 and the public core APIs replace the obsolete
archive-only wire format and private database imports. English PRD decisions
above remain required, including pure OTA core ownership and Sparkling pages.

Verified on the merged working tree:

- `pnpm -w build`: 29 projects passed (`/tmp/lynx-next-build7-20261003.log`).
- `pnpm -w test:type`: 37 projects passed (`/tmp/lynx-next-types6-20261003.log`).
- `pnpm -w lint`: formatting, lint and 44 workspace/27 published package
  boundaries passed (`/tmp/lynx-next-lint2-20261003.log`). Runtime source closure
  checks prevent the separate Node build entry from entering either device SDK.
- `pnpm -w test`: 438 files, 4,994 passed, 15 skipped, zero failures
  (`/tmp/lynx-next-unit5-20261003.log`).
- Android native unit tests: 153 passed, zero failures
  (`/tmp/lynx-next-android-unit5-20261003.log`).
- Swift native suites: 139 executed, 126 passed, 13 HTTP-service-dependent
  tests skipped, zero failures (`/tmp/lynx-next-swift-tests6-20261003.log`).
- Public matrix evidence/scenario checks: 115 passed
  (`/tmp/lynx-next-matrix-tests-20261003.log`).
- The standalone E2E TypeScript audit passes against the built public exports.

Both native consumers now verify the authenticated full inventory, retain
original descriptors for patched/reused files, use manifest-authenticated
transfer representations, and optionally select authenticated tar.br bulk
transport. Shared real-byte fixtures verify bulk success, corrupt transfer
fallback, decoded-size mismatch, embedded-manifest rejection and corrupt
original rejection. Native publication logs identify the transport actually
used. No device OTA result from this merged source has been recorded yet.

The dashboard was unreachable on port 3131; its launchd log reports inability
to open the configured startup script. Starting that existing script from this
session restored the service without changing its code or configuration.
The last PR job remains the cancelled `job-20260928230647-4uc5ag` (40 passed,
one failed, eleven unfinished). A fresh 54-scenario job and six-cell matrix
remain required; these unit/build results do not close G3.

The focused core operation suite also passes all 16 cases, including a new
concurrent patch-upsert test proving that independent bases and their reference
counts survive parallel publication (`/tmp/lynx-next-atomic-patch3-20261003.log`).
The later complete type check still passes all 37 projects, and the standalone
E2E audit and final lint pass. Native fingerprints were regenerated with the
public CLI before the merge checkpoint; fresh binaries must use those values.
