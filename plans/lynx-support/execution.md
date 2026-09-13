# Lynx implementation goal and execution ledger

Status: active on 2026-09-13. The English PRD is finalized and Sol High
implementation is in final adversarial review. Read the current
[handoff and completion plan](./handoff.md) first. Historical G1/G2 observations
below remain useful evidence but do not establish current acceptance.

## Goal

Execute the [approved PRD](./prd.md) in
`/Users/gronxb/workspace/hot-updater-lynx`, branch `codex/lynx-support`, based on
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

| Gate | State | Evidence needed |
| --- | --- | --- |
| G0: PRD review | Complete | Explicit user instruction to execute the PRD |
| G1: Native feasibility | Native packages and hosts build; current device rerun pending | Retain current bridge/resource/startup receipts on both OSes |
| G2: Package and examples | Implemented; aggregate validation pending | Final workspace checks and packaged consumer/deployment checks |
| G3: OTA and recovery | Not complete | Green full agent job and every current six-cell receipt on unchanged native binaries |

## Coordination

All agents must use this worktree explicitly. Native iOS, native Android and
framework fixtures have separate ownership. Root package/lockfile changes,
shared contracts, deployment integration and evidence reconciliation are owned
by the primary agent. Historical spike APIs and placement probes are retained
only as evidence and are not part of the production integration.

Implementation and adversarial correction use GPT-5.6 Sol with High reasoning.
The subagent that launches and waits for the full E2E job uses GPT-5.6 Sol with
Low reasoning; it reports failures back to Sol High implementation owners.

## Historical G1 evidence matrix

| Framework | iOS | Android |
| --- | --- | --- |
| ReactLynx | G1 A/B, image, font, core external JS, bridge and confirmation pass | G1 A/B, image, font, core external JS, bridge, confirmation and offline restart pass |
| VueLynx | Same core-resource G1 cases pass; generated async-template failure retained | Same core-resource G1 cases pass, including offline restart; generated async-template failure retained |
| OctaneLynx | Same core-resource G1 cases pass; generated async-template failure retained | Same core-resource G1 cases pass, including offline restart; generated async-template failure retained |

Record exact commands, binary/runtime identities, logs and results as work
completes. A missing result remains unverified. Never replace this matrix with
aggregate test counts that do not exercise its scenarios.

## September 13 Sol High implementation checkpoint

The current uncommitted worktree implements the consolidated PRD contracts:

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
  fingerprint discovery. The common CLI/server/storage paths remain
  engine-neutral.
- The optional Sparkling host owns the bridge, all managed resource loaders,
  primary/secondary authority, startup observations, recovery, leases, and
  same-process replacement of every managed runtime and view. Production
  `SparklingGo` and Android `:app` sources contain configuration and packaged
  host wiring only.
- Separate nonproduction iOS and Android matrix targets expose the lifecycle
  controls needed for strict six-cell evidence. The runner requires correlated
  process, generation, context, attempt, release, resource, patch, and transition
  events; it does not infer success from screen text or old logs.
- The Lynx default suite contains 25 scenarios: the shared default list minus
  only `metadata-v1-migration`. All delta, channel, fingerprint, stale-catalog,
  recovery, and crash-history scenarios remain enabled. The delta rollback chain
  requires real A-to-B and B-to-C forward patches and C-to-B and B-to-A reverse
  patches; archive fallback is not accepted as patch evidence.

Focused checks completed during this phase: 141 Lynx JS tests, 10 CLI promotion
tests, 66 Android controller/installer tests, two Android Sparkling tests, 63
Swift tests with 13 environment-dependent skips, 308 E2E unit tests, and 65
matrix contract tests. The server's 442 focused tests passed before the final
1.0.0 Supabase schema fold and require one final rerun. Both iOS schemes and
both Android applications build in debug/release as applicable. These results do
not close G2 or G3: full workspace checks, the current full-platform agent job,
and the real six-cell device run remain pending.

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
  `runtimeId`, emits versioned manifest-bound metadata, and explicitly requests
  `filePolicy: "preserve"`. Its 27 tests pass, including invalid compatibility
  declarations, reserved metadata, symlink escapes, and prior-output retention.
  Package type checking and build also pass.
- Six real prebuilt compiler-output runs passed independent comparison: 30 files
  retain their exact names and bytes, six Bundle IDs are distinct, and every
  sidecar binds the correct Bundle, OS, entry and native compatibility identity.
  Receipt: `/tmp/hot-updater-lynx-real-prebuilt-verification.json`. This proves the
  package adapter, not final CLI archives or device OTA.
- The CLI's explicit preserve path and archive-failure cleanup have 66 passing
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
