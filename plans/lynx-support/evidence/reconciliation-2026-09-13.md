# Lynx evidence reconciliation

Date: 2026-09-13. PRD decision commit:
`01bb61260b932e20d3e3f8a3e8e957369f887e17`, branch
`codex/lynx-support`. Worktree:
`/Users/gronxb/workspace/hot-updater-lynx`.

G1 and G2 have substantial historical evidence, and retained SDK3 native logs
establish public A → B operation for all six framework/OS combinations on earlier
implementations. The current Sol High implementation is uncommitted and changes
the client, native readiness, delta, reload, channel, fingerprint, resource, and
packaging paths. Historical receipts do not establish its acceptance. This record
preserves the evidence boundary; it does not close a current gate.

## Evidence that can still be inspected

The [framework](./frameworks.md), [iOS](./ios.md),
[Android](./android.md), and [packaging](./packaging.md) records preserve pinned
toolchains, binary profiles, hashes, negative cases, and known failed experiments.
Their chronological findings remain useful even where their status text is stale.

During this reconciliation, all **36 files in six frozen SDK3 A/B builds** were
rehashed against `examples/lynx/.hot-updater/g1/sdk3-summary.json`; sizes and hashes
matched. Its consumed runtime hash is
`a1eb27a0a47fdd0c4cefd1eeb588b55fbe30034e1c8bf86f7f59349478d31a52`.
This verifies retained compiler inputs, not a build or device run at the inspected
commit. SDK3 includes a main template, core dynamic component, external background
JavaScript, image, font, and font license.

Native profile IDs for these public receipts are:

- iOS: `sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v2`.
- Android: `android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v2`.

| Framework / OS | G1 and G2 evidence | Retained public G3 evidence | Required closure |
| --- | --- | --- | --- |
| ReactLynx / iOS | Native startup, bridge, resources, shared recovery probes; real CLI archives and native verification | SDK3 A → B; newer standalone Kysely A → B; first-content, image/font decode and managed-resource events; confirmed journal | Current client/native binary; explicit B-retain and unavailable-origin restart; public recovery scenarios |
| VueLynx / iOS | Same categories with the real Vue toolchain | Same retained SDK3 and Kysely A → B evidence | Same closure; framework-generated lazy-template failure remains separate |
| OctaneLynx / iOS | Same categories with pinned-source Octane | Same retained SDK3 and Kysely A → B evidence | Same closure; framework-generated lazy-template failure remains separate |
| ReactLynx / Android | Native startup, bridge, resources, shared recovery probes; real CLI archives and native verification | SDK3 A → B → retained B; both B logs resolve managed resources against the exact selected Bundle ID | Current client/native binary; unavailable-origin restart; complete public recovery evidence |
| VueLynx / Android | Same categories with the real Vue toolchain | Same retained SDK3 A → B → retained B evidence | Same closure; framework-generated lazy-template failure remains separate |
| OctaneLynx / Android | Same categories with pinned-source Octane | Same retained SDK3 A → B → retained B evidence | Same closure; framework-generated lazy-template failure remains separate |

Inspectable local receipt directories, relative to the worktree:

- `examples/lynx/ios/.probe-results/1789129633152-public-sdk3`: three original
  public A → B runs. Executable SHA-256:
  `f42f6c74948397e9f19ff0516937b8a9195868b7a4250e41f5bddb78db169f53`.
- `examples/lynx/ios/.probe-results/1789137337519-public-sdk3`: three subsequent
  A → B runs on the same recorded executable hash. Each Bundle/Release receipt
  matches the corresponding `examples/lynx/.hot-updater/e2e-kysely/*/receipt.json`.
  Each events file has two process selections, covering A and B, and the saved
  state has no pending attempt. This does not record a third retained-B process.
- `examples/lynx/android/.probe-results/1789131402052-public-sdk3`: summary plus
  `*-A.logcat.txt`, `*-B.logcat.txt`, and `*-B-retain.logcat.txt` for all frameworks.
  APK SHA-256:
  `1f82c0910f8941fd6c035115b4d52704b6d7b6d8226cfcabf80ea4289ef41cfc`.
  All six B/retain logs contain the exact selected Bundle ID for main template,
  image, external JavaScript, dynamic component and native font loading.
- `examples/lynx/.hot-updater/ota/receipts/*-B-sdk3-managed-zip.json`: original
  six public artifact receipts, cross-referenced by the SDK3 packaging table.
- iOS `.probe-results/1789101762985-recovery`, `1789101777314-contexts`,
  `1789101823642-failures`, and `1789101839340-capacity`: retained **private G1**
  result/event/journal records, including B/C exclusion, new Release for cached
  bytes, duplicate/secondary/no-primary contexts, fatal versus unknown errors,
  stale selection and capacity behavior. These are not current public OTA runs.

The Grok session's `compaction/segment_001.md` claims additional retain and
public recovery results under its `grok-goal-eb649b9620a6/implementer` scratch
directory. That directory is no longer present. Its claims cannot substitute for
the missing receipts. Partial later `.probe-results/*-recovery` directories do
not have a completed results summary. Public probe scripts do not disable the
delivery origin; retained local-resource events alone are insufficient evidence
of the PRD's offline restart scenario.

## Current contract versus the PRD

| Area | Current implementation | Current evidence boundary |
| --- | --- | --- |
| Framework independence | `@hot-updater/lynx` has separate runtime/build exports and no required React, Vue, or Octane dependency | Real compiler outputs exist; current six-cell device execution is pending |
| Public API | Check performs catalog authorization and nonretained native compatibility validation; `updateBundle()` prepares and stages; readiness returns a one-shot transition receipt; reload completes after all managed views recreate and propagates failures; reset persists then recreates and invalidates JS state | 141 focused JS tests pass; current device receipts are pending |
| Packaging | Build plugins declare artifacts, portable names, `downloadCompression`, and `patchAssetPath`; packaging consumes an immutable no-follow snapshot with 128 MiB archive/artifact, 512 MiB expanded, 1 MiB manifest, and 16 KiB Lynx-sidecar limits; archive, promotion, and fingerprint inputs are deterministic and mutation-checked | Focused CLI/server tests pass; final workspace and real deployment rerun are pending |
| Artifact response | Engine-neutral `ArtifactInfo` is capped at 528,384 UTF-8 bytes; URL resolution uses ordered batches of at most 16; valid manifest-only and archive fallback remain available; artifact lookup may omit corrupt optional patch rows while admin hydration stays strict | Focused server tests pass; final server/provider reruns and deployment remain pending |
| Provider patch lifecycle | Providers atomically retain at most 24 ordered base patches per target and reject deletion of Bundles still referenced by Releases or another Bundle's patch | Focused provider tests exist; final provider and server reruns are pending |
| Engine ownership | RN/Hermes handling lives in `@hot-updater/react-native`; bare and Rock use it; Expo owns Expo fingerprinting | Focused provider regressions exist; full final regressions are pending |
| Native artifacts | Both OSes implement bounded archive/raw/Brotli/BSDIFF installation, strict trust, fallback, cancellation, and atomic publication | 66 Android controller/installer tests, two Android Sparkling tests, and 63 Swift tests with 13 environment-dependent skips pass; final host/device validation is pending |
| Sparkling host | Packaged hosts own bridge, all managed resources, primary/secondary authority, readiness, recovery, and same-process generation replacement | Production and matrix native builds pass; real six-cell execution is pending |
| Agent E2E | Explicit Lynx manifest contains every shared scenario except RN legacy `metadata-v1-migration` | 308 E2E unit tests and 25-scenario dry run pass; full current agent job is pending |

The earlier timer and pre-render iOS confirmation paths were removed from the
production scaffold. Current host code attributes first content, required
resource success, and application readiness separately to the live primary
context. This is a source and focused-test result until the rebuilt host proves
the behavior on a device. The matrix contract also requires stale primary and
secondary authorities to fail with their original full identity after reload.

The final client surface does not claim native manifest or filesystem
install-identity access, user mutation, event listeners, or init-time insights.
It does not accept inert reload-mode or process-restart values. These removals
are source and focused-test findings. `isUpdateDownloaded()` now reads native
`nextSelection` from the current snapshot instead of a JS-local latch. None of
these findings establishes device acceptance.

The native reload callback now settles only after every registered managed view
has been attached to the replacement generation, and forwards reconstruction
failure. Reset persists the default scope before invoking that same recreation;
the JS client clears its state snapshot in a `finally` path. These are source and
focused-test findings until device receipts prove them.

The shared rollback scenario now creates and asserts actual reverse C-to-B and
B-to-A patches after the forward A-to-B and B-to-C chain. The scenario contract
rejects archive fallback as reverse-delta evidence. It has not yet passed in the
current full agent job or real six-cell matrix.

The settled storage rule retains shared content-addressed promotion assets during
rollback and retains superseded patch objects after patch-row replacement. No
cleanup acceptance is claimed; deletion remains future work until an atomic
ownership/reference proof exists.

Focused results reported for the current implementation are 141 Lynx JS tests,
10 CLI promotion tests, 66 Android controller/installer tests, two Android
Sparkling tests, 63 Swift tests with 13 environment-dependent skips, 308 E2E unit
tests, and 65 matrix contract tests. The 25-scenario manifest dry run also passes.
Both iOS schemes and both Android applications build in debug/release as
applicable. The server's 442 focused tests passed before the final 1.0.0 Supabase
schema fold and require one final rerun. Full workspace verification has not yet
run; these results must not be presented as final-commit or device evidence.

## Unresolved framework boundary

The pinned Vue and Octane framework-generated async-template path fails with
`lynx.loadLazyBundle is not a function`. React supplies that helper; the inspected
Vue/Octane runtimes do not. There is no retained evidence that this was fixed.
Successful `lynx.requireModuleAsync` background modules and core dynamic-component
loading prove their respective native resource paths and must not be relabeled
as successful Vue/Octane framework lazy loading. Preserve the failed experiment,
diagnostic and exact supported fixture boundary in user-facing documentation.
The PRD explicitly requires separate user review for any framework scope change.

## Remaining checks, in execution order

1. Finish the final adversarial review, rebuild both production scaffolds and
   matrix targets, and rerun the affected focused tests after any correction.
2. Run workspace build, types, lint, unit, and integration checks. Recheck RN,
   bare, Rock, Expo, server, promotion, and packaged-consumer behavior on the
   exact implementation that will be pushed.
3. Commit and push without the six protected staged-only helpers, then require
   green Integration on that exact commit.
4. Complete the user-requested `hot-updater-agent` full-platform Lynx verification
   on `standalone-kysely`; record job ID, tested commit, binary identities,
   terminal conclusion, and every scenario result. A queued job or dry run is
   not completion.
5. Run the public API across ReactLynx, VueLynx, and OctaneLynx on both OSes with
   one unchanged binary per OS. Require strict receipts for archive A-to-B,
   origin-off B activation/retention, real B-to-C BSDIFF, same-process all-context
   reload, stale authority, primary replacement, secondary fatal recovery, and
   unconfirmed recovery.
6. Update this record and PR #1300 with the final commit, job, binary hashes, and
   six receipts. Keep the Vue/Octane framework-generated lazy-template limitation
   separate from supported core external-JS and native dynamic-component paths.
