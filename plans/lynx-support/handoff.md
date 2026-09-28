# Lynx support handoff and completion plan

The latest `6dc6352db` React/iOS matrix passes pre-confirm fatal full-stack
recovery/native back and pre-confirm process recovery, then fails the reverse
delta helper's obsolete SHA-256 Bundle ID assertion. The helper now uses the
shared UUIDv7 predicate. A targeted real-server probe creates both reverse
BSDIFFs successfully with archive-free delivery; device application is pending.
Retain `evidence/public-matrix-6dc6352db-failure.json`; no full cell is claimed.
Shared full job `job-20260928211636-6hdwci` is running on actual `6dc6352db`.

Latest follow-up (2026-09-29): shared job `job-20260928211636-6hdwci` remains
queued, actual checkout pending. The `7cc24042b` matrix stops at an ambiguous
native button after React/iOS C reconstruction (zero complete cells). Manual
role-qualified targeting verifies both stale contexts, then a real confirmed-C
detail fatal exposes iOS duplicate failure classification. The current changes
fix that package path and recovery classification, align matrix failure selection
with durable suppression, and pass 135 focused matrix tests plus Swift's 137
executed tests (13 skipped). Fresh native matrix builds and device runs are next.
The successful Android same-APK navigation recheck is retained separately from
its earlier unexplained black screenshot. Read the final execution checkpoint
and `evidence/public-matrix-7cc24042b-failure.json` before resuming.


Updated: 2026-09-29 (Asia/Seoul).

Latest execution checkpoint: shared full job `job-20260928195209-rzyw0v` finishes
50/52 (25/26 per OS) on actual commit `a5bb32fb3`. Both failures overwrite the
unobserved confirmed-detail open request with evidence capture. The scenario now
waits for detail observation and confirmed embedded recovery without relaunching;
84 focused tests pass, and a fresh full run remains required.
Preserve exact-commit results even when
later local matrix fixes are pushed. The independent React/iOS matrix reached C
readiness but failed because only the initial primary authority was captured;
see `evidence/public-matrix-a5bb32fb3-failure.json`. Both matrix shells now capture
the live stack at retirement. The same-Release phase uses public primary-owned
navigation/admission/reload, with strict reopened-detail lifecycle evidence.
Focused matrix validation is 131/131; fresh device acceptance remains outstanding.
Production iOS on `a5bb32fb3` passed real navigation/readiness with diagnostics
absent (`evidence/production-scaffold-ios-a5bb32fb3.json`), without network OTA
because the endpoint was unconfigured. Production Android `94ad81609` builds
with diagnostics absent and 14 ARM64 libraries aligned to 16 KB; image/font,
detail readiness and JavaScript close pass. System back produces a black
screenshot on the Android 17 emulator; diagnose before marking this gate passed.

## Resume location

- Worktree: `/Volumes/SSD_2TB/workspace/hot-updater-lynx`
- Branch: `codex/lynx-support`
- PRD decision HEAD: `01bb61260b932e20d3e3f8a3e8e957369f887e17`
- Pull request: [#1300: feat(lynx): add OTA updates for Lynx apps](https://github.com/gronxb/hot-updater/pull/1300)
- Previous Grok session: `01a09054-0a33-7111-a493-8ddacfda539a`
- The original checkout, `/Volumes/SSD_2TB/workspace/hot-updater2`, contains earlier
  work and must be preserved. Run commands in the worktree above explicitly.

The Grok session ended at an earlier handoff commit. The English PRD and
implementation were subsequently committed and pushed. Git and live job results
take precedence over either session summary. Do not start a second process
against this worktree while the current execution is active.

## Current goal

The user cleared the previous Codex goal and authorized a replacement on
2026-09-13. The new goal is active and names the PRD, worktree, branch, and PR.

Complete the English [PRD](./prd.md), retaining framework-independent Lynx
support for ReactLynx, VueLynx, and OctaneLynx on iOS and Android. Reconcile G1–G3
evidence, resolve native and delivery correctness findings, preserve React Native
behavior, and finish a real full-platform `hot-updater-agent` job on
`standalone-kysely`. Keep the PR reviewable; merging and npm releases are outside
this goal.

The agent job must use `examples/lynx/.env.hotupdater`, the shipped `e2e:lynx`
runner, app ID `com.hotupdater.lynxexample`, and the shared default scenarios
except `metadata-v1-migration`, which the user explicitly excluded after the
goal was created. Delta updates are now required. CI, a dry run, individual
passing scenarios, or weakened assertions do not establish completion. The six
framework/OS evidence obligations remain separate from this shared runner gate.

Subsequent user amendments also require normal Sparkling scaffold integration
through library configuration instead of application-owned native workarounds,
and engine-neutral common Hot Updater packages with RN/Hermes and Expo-specific
policy owned by their integration packages. These requirements are recorded in
PRD sections 2.1 and 2.2 and remain part of the active completion goal.

The user also approved same-process managed runtime recreation on **both** OSes.
PRD section 5.6 replaces the original process-lifetime selection invariant with
one selection per managed generation plus explicit serialized teardown and
reconstruction. The app stays foregrounded; an exit, restart trampoline, or test
driver relaunch does not implement immediate activation.

The user's latest execution instruction supersedes the earlier model and
delegation notes: continue directly in the current task without subagents. The
existing adversarial review remains an input to reconciliation, while all
remaining implementation, diagnosis, and verification are performed here.

## Latest full-run diagnosis

Full job `job-20260928191114-vsk520` on `da5ae4636` finishes **49/52**
(iOS 25/26, Android 24/26). All four previous Android startup timeouts pass.
The native evidence identifies three harness defects: a two-second forced
relaunch before verified fatal handling, an incorrect pending-download
expectation for server A adopting embedded A, and an initial two-context
expectation before Android attaches its secondary Activity. All are fixed in pushed `9cbc0c985`
with failing-before regressions; the 91 focused tests pass. The Android
reconstruction evaluator also passes the unchanged captured native journal.
Unconfirmed Releases no longer appear as crashed Bundles in shared test metadata.
See `evidence/shared-e2e-da5ae4636.json` and the execution ledger's final section.

The native-helper neutrality follow-up passes rebuilt workspace build, types and
lint, plus **3,908/3,908 units in 350 files** (`/tmp/lynx-post-vsk-units.log`).
Full job `job-20260928195209-rzyw0v` was requested on `9cbc0c985`; another task
currently owns the bot devices. Preserve that task and all six staged-only helpers.
Historical best remains 51/52; no current complete public matrix cell is claimed.

An additional local doctor fix now resolves non-semver dependency specifiers to
installed versions. The isolated production-tarball fixture passes key generation,
fingerprint, app doctor and four signed deployments across two populated projects.
All archive/asset signatures and page hashes verify, with bidirectional namespace
isolation. See `evidence/isolated-cli-flow.json`; this does not replace either
native gate. The doctor/resolver suites pass 62/62 and CLI build/types/lint pass.
All **3,911/3,911 workspace units in 350 files** and workspace lint now pass.
The queued device job has no resolved commit yet. Push these tested changes
before it starts and verify the exact checkout commit from the actual job.

## September 29 resume checkpoint

- Fresco adaptation commit: `6d50f8a49`.
- Fresco 3.4 alone caused a `CloseableBitmap` ABI crash. The user approved a
  Fresco-only workaround; the PRD records it. A package-owned, checksum-pinned
  source rebuild now fixes the class/interface ABI and animation callbacks.
  The example uses upstream pool initialization without `BUFFER_MEMORY`.
- All Android release products build; each APK's 28 ARM64/x86_64 libraries pass
  ELF and ZIP 16 KB alignment, and the AAB reports `PAGE_ALIGNMENT_16K`.
  One unchanged matrix APK passes React/Vue/Octane real image/font/readiness
  smoke checks on a 16 KB device. React's actual button admits a separate
  detail bundle in the same generation. All 31 Sparkling JVM tests pass.
  See [the retained smoke evidence](./evidence/fresco-16kb-smoke.json).
- The iOS adapter now uses Sparkling's container appearance callback and connects
  the iOS 26 content-pop gesture to the visible Sparkling page. An incremental
  Release binary passes actual back, cancelled pending-page swipe, and animated
  JavaScript close. Runners use agent-device's real edge-swipe preset. The React
  matrix and shared E2E detail now also request nonanimated close; verify that
  synchronous path on every full run. A clean matrix build on `66a2df9be` now
  passes four targeted navigation checks, including nonanimated close, in one
  unmodified process. Its installed full app tree matches the build receipt;
  see [the native navigation smoke evidence](./evidence/ios-navigation-smoke.json).
  The original appearance-only patch
  at `/Users/gronxb/.codex/lynx-support/ios-appearance-investigation.patch` is
  superseded. Do not count debugger-mutated processes as acceptance evidence.
- Full workspace unit tests on `6d50f8a49` pass 3,854/3,854 in 343 files.
  Its clean Android production binary passes real main/detail readiness and
  Sparkling open/close navigation on the 16 KB emulator.
- Jobs `job-20260928151428-detpgp`, `job-20260928152140-ogt541`, and
  `job-20260928153356-xfwoeg` failed in setup before any scenario. Normal
  BSDIFF builds now preserve the committed WASM (`74fa25c2e`), and device
  cleanup is scoped to the runner's own session (`705635434`). Android Release
  builds and native source attestation pass. The latest iOS bootstrap failure
  was reproduced with the bot's inherited environment: a child shell selected
  system Ruby despite mise's explicit version argument. The bootstrap now
  forces selected tool paths first with `MISE_ACTIVATE_AGGRESSIVE=1` and pins
  Ruby 3.3.10. Rerun the full gate; best remains 51/52 and the six current
  matrix receipts are still required.
- Commit `3f860ef7c` fixes multi-page pending metadata waits to use the exact
  republished Release ID and forbids automatic relaunch while observing it.
  Driver tests pass 61/61, BSDIFF tests 17/17, and orchestration tests 2/2.
- Full job `job-20260928154852-ej3uiq` on `d689f46d6` has passed both native
  Release builds and entered device execution. It does not include the subsequent
  iOS navigation change. Its scenario result is pending; best remains 51/52.
- That job exposed two Android startup races: a two-second configuration fallback
  bypassed the test proxy and returned 404; a crash fixture's `STARTING` marker
  was accepted before the recovered stable bundle reported readiness. Both have
  reproducing regressions. The E2E entry now requires proxy configuration before
  initialization and publishes no ready marker before confirmation or on startup
  failure. All 80 bootstrap/runtime-observation/driver tests pass after the fix.
  A full job on the navigation and startup fixes remains required.
- Neutral CLI policy was moved behind integration hooks in `0c76a3d71` and
  `a18776c50`; focused common CLI/RN/Expo suites passed 521/146/44 tests.

## Latest September 29 validation

- Full job `job-20260928181940-4izq1i` is running on `ca366bcb6`. The separate
  matrix now passes C reconstruction/readiness, then exposes destructive repeated
  iOS diagnostic journal restoration (82 live events become zero). The explicit
  successful restore plus deferred cleanup must be idempotent. Both native
  diagnostic APIs now preserve the restored journal when no backup is pending;
  reproducing tests verify exact bytes and sequence continuation. Swift journal
  tests pass 22/22 and Android diagnostics pass 6/6. The iOS fingerprint and both
  plist values are refreshed; Android remains unchanged. Retained evidence: `evidence/ios-diagnostic-double-restore.json`.
- The common CLI no longer depends on RN through the Apple helper. Bare, Rock
  and Expo supply RN CocoaPods policy through the selected integration. The
  isolated production-tarball install additionally exposed a Kysely root-export
  leak; its helpers now live under the Kysely adapter entrypoint. CLI help and
  Lynx/Cloudflare scaffolding execute without RN, Expo or Kysely installed.
  Scaffold doctor correctly rejects unresolved deployment placeholders; this is
  not remote infrastructure or complete onboarding proof. Retained evidence:
  `evidence/isolated-cli-neutrality.json`. All 27 build and 35 type projects pass,
  workspace lint passes, and 36 focused tests pass. Full units pass 3,893/3,893
  in 348 files before the subsequent three stored-exclusion test cases.
  The remaining native-helper audit is implemented locally: prefer Xcode `.app`
  products over dependency frameworks, remove the unused RN Gradle port branch,
  and use generic native-tool progress stages. Two reproducing selection tests,
  both helper type projects and focused lint pass. Helper builds remain pending;
  these edits are not yet part of the pushed device-job commit.
  The follow-up also moves the Android development port default from the common
  launcher into RN build integrations, preserving explicit overrides and omitting
  implicit Lynx forwarding. Fourteen focused native-policy tests pass; the new
  plugin-core field and RN export still need rebuilt package validation.
- The full shared job's iOS result is 25/26. Its multipage scenario explicitly
  deletes app data, then incorrectly compares the new journal's sequence 1 with
  the deleted journal's sequence 1. The driver now archives the completed ledger
  after a successful explicit deletion and retains every receipt in final
  evidence. Failed resets, normal controls, relaunches and OTA transitions keep
  strict overlap checks. The reproduction and full driver/ledger suites pass
  67/67. This fix still needs a fresh complete device run. Android's first four
  failures are startup timeouts under severe host load; later scenarios pass,
  but causation has not been established.
- Full job `job-20260928181940-4izq1i` finishes **46/52** (iOS 25/26, Android
  21/26). The last Android failure incorrectly reads iOS exclusion field names;
  the captured device state has the expected Release once in `unconfirmed` and
  no `crashed` entries. Use OS-specific raw fields and the native Android empty
  default, retaining strict malformed/duplicate checks. Driver/ledger/store
  suites pass 79/79 after both harness fixes. Retained full results and actual
  exclusion state: `evidence/shared-e2e-ca366bcb6.json`. A new full device run is
  required; historical best remains 51/52 and no complete matrix cell is claimed.
- Fresh full job `job-20260928191114-vsk520` ran on pushed `da5ae4636`
  after PR checks pass. Do not overlap heavy local builds with device execution.
  The read-only observer also captures native exclusion fields on failures.

- `26b23ee18` builds both clean native matrix targets. Its iOS B-to-C phase
  recreates both pages, loads all resources and confirms C in the same process,
  but the readiness predicate rejects any two-page generation start. Shared
  predicate/collector membership validation now accepts actual iOS and Android
  attachment order while requiring both pages' complete evidence. Both platform
  regression tests fail before the fix; replay of the real C journal passes.
- Pending reconstructed detail admission also holds primary confirmation. The
  E2E control loop now starts after configuration/resources while confirmation
  remains pending, so inspection/cancellation cannot deadlock. It still publishes
  no ready marker until native confirmation. Five focused suites pass 52/52;
  the complete Lynx E2E unit project passes 460/460 in 22 files, including real
  compiler builds. Example types and targeted lint pass. The attempted full verify on `26b23ee18`
  stopped during PR-check waiting and never queued a job. Both complete device
  gates must be rerun after committing these corrections.

- Full job `job-20260928171631-2fpuk1` is terminal **49/52**, iOS 24/26 and
  Android 25/26. Historical best remains 51/52. iOS failures (fingerprint and
  close timing) are fixed. Android's reconstructed pending-page fixture lost
  its next-page diagnostic during replacement; preserve the unconsumed
  observer until the new detail consumes it. Old-page progress observers still
  clear. Native evidence is retained in
  `evidence/android-reconstructed-pending-diagnostic.json`.
- Android fingerprint and three manifest values are refreshed; the normal CLI
  verifies both platform fingerprints. Sparkling JVM tests pass 31/31 and
  diagnostics pass 6/6 after fixing a prior extra class-closing brace.
- The `d3cbbd6f9` matrix opens B detail through the now-visible SDK button, but
  rejects its pre-navigation installation authorization as stale. The sample
  now rechecks the same Release after detail admission before installing.
  The native stale-selection contract is unchanged. All 121 matrix tests,
  example types, and three real compiler builds pass. Rebuild/rerun required.
- `d3cbbd6f9` full workspace units pass 3,866/3,866 in 343 files; workspace
  lint passes. The 413/413 full integration result remains from `972c11e94`.
- The scoped manual session `lynx-primary-pause-probe` was closed. No bot
  devices were modified by the failure observer; both captured journals are
  under `/tmp/lynx-2fpuk1-native-journals`.

- The `c4a9985a5` matrix stops before B-to-C navigation: the prepared-update
  action lies below the viewport, despite a misleading hittable flag. Compact
  SDK-only layout fixes all three samples; the driver rejects offscreen
  centers. The reproducing geometry test fails before the fix; 121 matrix
  tests, example types, and all compiler builds pass after it. Rebuild and
  rerun the native matrix. No complete matrix cell is claimed.

- Current full job also exposes an iOS detail-close observation race: capture
  stops at sequence 276, and native back completes at 277. Read-only durable
  evidence is retained in `evidence/ios-detail-close-race.json`. All single-page
  closes/backs now wait for exact native closure evidence, including pending
  cancellation. Both reproducing tests fail before the fix; 72 related tests
  pass after it. No native change or new fingerprint is needed for this fix.
- `c4a9985a5` passes both native matrix builds with the refreshed fingerprint.
  The matrix is running with dedicated devices and results at
  `/tmp/lynx-matrix-c4a9985`; log `/tmp/lynx-matrix-c4a9985.log`.

- Primary-context OTA correction `1bd67a4a5` passes both clean native matrix
  builds. Before device execution, the current full E2E exposes a stale iOS
  fingerprint from the host lifecycle change. The normal CLI regenerates the
  fingerprint and both configured plist hashes; Android's hash is unchanged.
  New native receipts and a full E2E rerun are required after this refresh.

- `972c11e94` passes the complete workspace unit suite (3,865/3,865, 343 files),
  all 35 workspace type projects, workspace lint, and both clean native builds.
  Full job `job-20260928171631-2fpuk1` uses exactly that commit for native setup
  and all four device shards. Native builds pass; scenario execution is active.
- Its public matrix discovers that secondary-page catalog authorization is
  correctly rejected with `STALE_CONTEXT`. The added detail controls are removed.
  The primary SDK page now navigates, waits for the new detail's durable native
  admission, and installs/reloads from the retained primary. Native authority
  is unchanged. The before-reload receipt is separated from offline retention
  so it names the actual current detail context. New matrix execution is needed.
- The full workspace integration rerun passes **413/413 tests in 28 files**,
  recorded in `/tmp/lynx-972c11e-workspace-integration.log`. No database code
  changed for the earlier timeouts. The primary-authority corrections pass
  120 matrix tests, example type checking, targeted lint, and real React, Vue,
  and Octane compiler builds; clean native/device matrix validation is next.

- Latest completed full job `job-20260928162042-ocwb3m`: **46/52**, iOS 24/26,
  Android 22/26. Failures: iOS manifest-diff log query timeout and multi-page
  reconstruction evidence; Android three pre-ready crash/font checks and one
  detail admission race. `job-20260928164123-6zd6ks` was cancelled during setup
  because it did not include these fixes. Queue a new full run on the fix commit.
- Captured iOS C pages are truly rebuilt/admitted, but lacked `pageOpened`.
  The package now emits it after native stack attachment. Normal multi-page
  checks wait for matching admission/terminal evidence; Android originally
  captured first content at sequence 23 before admission at 24/25.
- Crash fixtures now inject verified pre-ready failure before optional resource
  warmup. Strict font/journal/recovery assertions remain. Public React/Vue/Octane
  detail controls from `972c11e94` are superseded by the primary-context flow.
  All three compiler builds, 120 focused tests, example types and targeted lint
  pass. New native builds and complete device runs remain required.
- `b23299eda` matrix got through journal diagnostics, B offline retention, and
  missing/corrupt C rejection; it stopped at the missing detail update control.
  Its device session was cleaned up successfully. No whole cell has passed yet.
- MySQL's last serialization test passed in isolation without code changes;
  no database fix was made for the transient integration timeouts.

- The clean `5c239fc3d` public matrix run reaches native journal diagnostics.
  It exposes unordered NSDictionary receipt members being compared with
  `JSON.stringify`; all six actual receipts have equal bytes, hashes, and
  metadata. Strict structural equality fixes that false failure without relaxing
  byte equality. All 36 diagnostics/runner tests and captured-receipt replay
  pass. Matrix teardown now releases its own device session on failure.
- Current full job `job-20260928162042-ocwb3m` used `aa2ade4c3` for native setup
  and `5c239fc3d` for device shard worktrees. Both native builds pass, but this
  mixed-source run must not establish final acceptance. Execution has reported
  Android recovery font-diagnostic validation and an iOS simulator-command
  timeout. A follow-up is queued as `job-20260928164123-6zd6ks`.
- Broad integration is not green: 402 pass, one failure, ten skipped, with
  DynamoDB cleanup and MySQL setup timeouts. Focused retry passes DynamoDB 63/63
  and MySQL 9/10; the fumadb patch/deletion serialization deadline remains.

- `job-20260928154852-ej3uiq` on `d689f46d6` is terminal **46/52**
  (iOS 25/26, Android 21/26). Historical best remains 51/52.
- `job-20260928162042-ocwb3m` started on `aa2ade4c3`, which includes the
  navigation and startup fixes. Its native builds are running. It does not
  contain the subsequent poller deadline or matrix status corrections below.
- The Android stack diagnostic took 28,149 ms, exceeding the poller's old
  20-second deadline. Native journal sequence 215 proves all pages closed to
  main, but the halted poller could not publish the follow-up evidence. The
  deadline now matches the driver's 60-second bound. A regression fails before
  this fix and passes afterward.
- The public matrix build on `7a3ced5f2` passes both native builds. The device run
  completes iOS depth-16 native back but fails on a stale UI status expectation.
  Retained-page waits now preserve diagnostic/error text and check the main page
  alongside unchanged native evidence assertions. Poller/matrix/bootstrap/driver
  suites pass 189/189; example type checks pass. Rebuild and rerun the matrix.
- `aa2ade4c3` fixes the CLI doctor's cross-package test type root. Doctor tests
  pass 57/57, all 35 workspace type checks pass, and workspace lint passes.
  Integration tests are still running with DynamoDB and MySQL timeouts; inspect
  `/tmp/lynx-7a3ced5-workspace-integration.log` before counting any acceptance.
- The production iOS wrapper was interrupted during its cold build to allow
  these source changes. Resume it after committing; its current output is not
  a successful artifact receipt. Keep the dedicated matrix simulator and
  16 KB emulator separate from the bot's devices.

## Current implementation checkpoint

The September 13 PRD contains the user's final decisions: three equal framework
targets, real delta delivery, no Lynx migration of React Native's legacy metadata,
ordinary Sparkling scaffold configuration with library-owned native behavior,
engine-neutral common packages, and foreground managed-runtime recreation on
both OSes. The implementation now covers the main contract and the known
adversarial findings. GitHub Integration is green through `ba25ecd98`; focused
checks are green on `f54a3ae47`, and the full device run remains the acceptance
gate.

| Work area             | Current implementation                                                                                                                                                                                                                                                         | Remaining evidence                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| JS runtime            | Check-time catalog authorization and nonretained compatibility validation; prepare-and-stage starts only in `updateBundle()`; atomic channel switch/reset; one-shot transition receipts; reload resolves after all managed views recreate and propagates failures              | Final workspace checks and device behavior                           |
| Native artifacts      | Strict archive and manifest verification, raw/Brotli changed files, real BSDIFF, verified fallback, cancellation, durable atomic publication, and later-launch verification on both OSes                                                                                       | Device delta receipts                                                |
| Neutral delivery      | Mandatory BuildPlugin artifacts, portable names, `patchAssetPath`, and `downloadCompression`; deterministic no-follow packaging, promotion, and fingerprint inputs; bounded artifact responses and URL resolution; archive-only compatibility for ambiguous older publications | Full RN/provider/server regression suite and current real deployment |
| Framework ownership   | RN/Hermes build and fingerprint policy moved to `@hot-updater/react-native`; bare and Rock use it; Expo owns Expo fingerprint discovery                                                                                                                                        | Final workspace regression checks                                    |
| Sparkling integration | Optional packaged iOS/Android hosts own bridge, resources, readiness, recovery, leases, and all-container generation replacement                                                                                                                                               | Run the lifecycle matrix on devices                                  |
| Production examples   | `SparklingGo` and Android `:app` contain configuration, registration, and packaged host/view attachment only; current native builds pass                                                                                                                                       | Current device acceptance                                            |
| Matrix harness        | Separate iOS scheme and Android module reuse one binary per OS across React, Vue, and Octane; strict correlated receipts reject synthetic patch or stale-context evidence                                                                                                      | Real six-cell device execution                                       |
| Shared E2E            | The 25 applicable shared scenarios exclude only `metadata-v1-migration`; `sparkling-multipage-ota` adds the page-based Sparkling scenario, for 26 scenarios per OS                                                                                                             | Pass a fresh full job on both OSes                                   |

The final prerelease client omits manifest, filesystem install-identity, user,
event-listener, and init-time insights APIs because the native integration has no
authoritative implementation for them. It also omits ignored reload-mode values:
the packaged native reload is the default, while
`setReloadBehavior("custom", handler)` requires a real handler.
`isUpdateDownloaded()` reads the authoritative native `nextSelection` from the
latest state snapshot instead of maintaining a JS-local success latch.
Default reload resolves only after every managed runtime and view has been
recreated and rejects on reconstruction failure. `resetChannel()` durably resets
the scope first, recreates the complete generation, and clears the JS snapshot
on either success or failure.

Shared packaging rejects archives or individual artifacts over 128 MiB, expanded
output over 512 MiB, signed manifests over 1 MiB, and Lynx sidecars over 16 KiB.
Portable artifact and fingerprint inputs have deterministic ordering. The common
database contract caps each target at 24 ordered base patches, replaces patch
rows atomically, and rejects Bundle deletion while a Release or another Bundle's
patch still references it.

The server limits serialized `ArtifactInfo` to 528,384 UTF-8 bytes and resolves
changed-file URLs with at most 16 concurrent operations while preserving order.
It uses a valid bounded manifest representation or verified archive fallback,
and artifact-only lookup may omit corrupt optional patch rows while strict admin
Bundle hydration continues to expose them. Archive creation is deterministic;
promotion revalidates archive structure, manifest coverage, and hashes; native
fingerprint providers constrain roots and reject mutation during hashing.
Rollback cleanup never deletes shared content-addressed promotion assets, and
patch replacement never eagerly deletes the superseded patch object. Cleanup is
deferred until a future atomic ownership/reference proof can authorize deletion.

The shared rollback chain requires real forward A-to-B and B-to-C BSDIFF plus
reverse C-to-B and B-to-A BSDIFF. Archive fallback cannot satisfy those patch
assertions.

The server contract is still unreleased. Supabase atomic patch publication is
part of the existing 1.0.0 initial migration; there is no 1.0.1 migration,
doctor requirement, or separate infrastructure upgrade for this work.

Focused validation on the current implementation includes Lynx package and
example type checks, Android Sparkling unit tests, workspace lint, 429 E2E unit
tests in 22 files, and 17 focused crash projection/recovery tests. GitHub
Integration passed on the pushed implementation in 14 minutes 20 seconds. These
results do not replace the full `hot-updater-agent` job or the six device cells.

The E2E bot reads `e2e/lynx/default-scenario-names.json` from the checked-out PR
commit and routes Lynx jobs to `examples/lynx` with application ID
`com.hotupdater.lynxexample`.

The earlier `348284787` checkpoint passed focused package type checks,
workspace lint, and 207 recovery/driver E2E unit tests. Its subsequent full job
`job-20260921204853-cw3i89` failed. The resume checkpoint above supersedes its
previous queued status. The active goal remains
unfinished until both 26-scenario platform runs pass and the final records are
reconciled.

## Historical E2E campaign

Full job `job-20260921154048-iwq7hq` established a new best combined result of
46/52 on `ba25ecd98`, with iOS at 24/26 and Android at 22/26. It exposed four
concrete causes rather than an unsupported feature boundary:

- iOS native back gestures were issued faster than Sparkling navigation could
  commit them, so a retained depth-16 stack survived into the next multi-page
  phase. The scenario now waits for the exact native route-close depth after
  every back action.
- Android registered its runtime lifecycle listener before `LynxKit.load()`, when
  no JavaScript proxy existed. The listener is now registered immediately after
  load, so detach completion can settle managed replacement. Android process
  recovery evidence now also maps durable unconfirmed Release IDs back to their
  Bundle IDs instead of requiring a React Native-style `crashed` array.
- Native source changes left `examples/lynx/fingerprint.json` and the embedded
  native hashes stale, so both fingerprint scenarios rejected deployment.
- An expected-crash launch cleared the public runtime marker only before the
  crashing process. The recovery process could therefore satisfy readiness with
  the stale crash marker before publishing the recovered generation.
- A long-lived Android process retained two legitimate font diagnostics while
  the bounded journal had evicted the first generation boundary. Recovery now
  accepts only an evicted prefix whose remaining native events all carry the
  exact diagnostic identity; duplicate log sources and any mismatched or fatal
  retained event still fail closed.

The runtime fixes are committed in `b2929c66d`, `c7bbbf1f8`, and `a1ea81331`.
Commit `bfad8131a` additionally rebuilds every framework's embedded A fixture
before creating the matrix binaries, preventing stale compiler output from
entering a current artifact. Focused unit, native, type, lint, and GitHub
Integration checks pass through `ba25ecd98`.

Commit `ba25ecd98` makes managed resource URLs generation-specific without
changing the signed manifest path. Android and iOS accept only the strict
positive generation query, and the Android evaluator requires redirected font
evidence from the matching confirmed generation in the current OS process.
Focused Android `force-update-auto-reload` and the actual forward/reverse BSDIFF
rollback chain pass; Swift `LynxControllerLocalTests` pass 32/32.

Commit `f54a3ae47` refreshes the native fingerprint, clears the runtime marker
again before crash recovery, uses `agent-device back --system` for the iOS
native-back proof, and correlates truncated Android journal prefixes without
weakening identity or fatal-boundary checks. Targeted job
`job-20260921181047-umah90` passed 51/52 on that commit: iOS passed 26/26 and
Android passed 25/26. The only failure was the final Android
`sparkling-multipage-ota` generation. The launch-wide log window still included
three already observed font diagnostics while the bounded native journal had
evicted an earlier page generation, so correlation failed closed with
`diagnostic.count`. Commit `348284787` now creates a new Android log checkpoint
after every successful managed-resource validation. Each later validation
therefore sees only unverified diagnostics while retaining the strict native
identity, ordering, font-load, readiness, and fatal-boundary checks. Full job
`job-20260921204853-cw3i89` must finish with iOS 26/26 and Android 26/26 before
this gate is closed.

## Preserve staged-only files

The user explicitly asked the Grok session to leave unnecessary PR-diff files
staged without committing them. These six files were already staged at handoff:

- `examples-server/hono-kysely-pglite/hot-updater_migrations/migration_2026-09-11T14-30-47.sql`
- `examples-server/hono-kysely-pglite/src/db.ts`
- `examples-server/hono-kysely-pglite/src/localFsStorage.mjs`
- `examples-server/hono-kysely-pglite/src/localFsStorage.ts`
- `examples/lynx/.gitignore`
- `examples/lynx/scripts/e2e-kysely-deploy.mjs`

Preserve their contents and staging. Agent jobs check out the pushed PR commit;
they cannot use these local-only changes. Commit explicit implementation paths
when required for the next job, without sweeping these files into a commit.

## Completion sequence

1. Preserve the Fresco adaptation and existing staged-only helpers. Reconcile
   each subsequent receipt against its actual source commit.
2. Build both production scaffold targets and both matrix targets. Run workspace
   build, types, lint, unit, and integration checks, then update the component
   evidence with exact commands and results.
3. Commit explicit implementation paths without the six staged-only helpers,
   push the branch, and wait for Integration on that exact commit.
4. Queue a fresh full job on the corrected pushed commit and diagnose each
   reproducible failure directly until both platform runs are green.
5. Run the separate public matrix with one unchanged binary per OS across React,
   Vue, and Octane. Require six strict receipts, then update the English PRD,
   evidence, and PR with the verified commit, binaries, job, and cell results.

```sh
cd /Volumes/SSD_2TB/workspace/hot-updater-lynx
hot-updater-agent status -limit 5
hot-updater-agent verify -platform full -profile standalone-kysely -env-target examples/lynx/.env.hotupdater
# After the command returns a job ID:
hot-updater-agent reason <job-id> -tail 240
hot-updater-agent wait <job-id> -tail 240
```

The first resumed invocation log is
`/tmp/hot-updater-lynx-resume-agent-verify-20260913.log`. Future results belong in
this document or a linked dated evidence record. Preserve exact commit and job
IDs so passing checks cannot be attributed to a different implementation.
