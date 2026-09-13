# Lynx evidence reconciliation

Date: 2026-09-13. Inspected commit:
`84244ae429a899bf5631bbc99de3675a03fdaddf`, branch `codex/lynx-support`.
Worktree: `/Users/gronxb/workspace/hot-updater-lynx`.

G1 and G2 have substantial recorded evidence, and retained SDK3 native logs
establish public A → B operation for all six framework/OS combinations. They do
not establish completion of the current implementation. The singleton client,
native readiness, reload, channel and fingerprint paths changed afterward.
This record preserves the PRD acceptance criteria; it does not close a gate.

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

| Area | Current source | Reconciliation needed |
| --- | --- | --- |
| Framework independence | `packages/lynx/package.json` has no required React, Vue or Octane dependency; runtime and Node build exports are separate | Rebuild and exercise all three real compiler graphs with the current exported runtime |
| Public API | `HotUpdater.init`, `checkForUpdate`, `update.updateBundle()`, `notifyAppReady`, `getLaunchInfo` and additional RN-like methods; no exported `createHotUpdater` | Earlier SDK3 tests used a previous API; update public contract documentation and its native receipts together |
| Packaging | App-owned callback receives `cwd`, `platform`, packaging `bundleId`, empty attempt `outDir`; returns `entry` and `runtimeId`; sidecar schema 1; explicit `filePolicy: "preserve"` | Existing archive evidence remains relevant; rerun changed shared CLI boundaries and current package consumer checks |
| Identity and signing | Manifest-covered `hot-updater-lynx.json`; native compatibility equality; build-plugin signing resolver | Retain mismatch/signature rejection and no-redownload assertions through final changes |
| Additional scope | Client supports fingerprint selection and reload; example includes fingerprint inputs and a React E2E overlay | PRD G4 originally deferred these. Record the later user-requested scope and actual supported semantics; do not silently rewrite the original gate |
| Agent E2E | `e2e:lynx` exists; shared controller launches `framework=react` on Android and `--ota-framework=react` on iOS | Full-platform standalone E2E is an additional required result and proves the React host path. It does not replace the Vue/Octane matrix |

Two iOS readiness regressions at the inspected commit require correction before
completion. `PublicHost.bind` schedules `observedContent` after a fixed 0.5-second
delay. `PublicContainerController.viewDidLoad` calls `begin`, `observedContent`,
and `notifyAppReady` before recording `publicBeforeEvaluation` or creating the
Lynx container. These calls can authorize confirmation without actual first
content or essential background bootstrap, contrary to PRD sections 5.5 and 7.
The corresponding source-string assertions in `suite-manifest.spec.ts` do not
validate startup authority. The real `containerDidFirstScreen` callback already
exists and must remain distinct from the application's readiness signal.

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

1. Restore content/readiness authority and add a behavioral regression proving
   that time elapsed or controller creation cannot confirm a candidate. Verify
   fatal and unconfirmed startup recovery against the corrected public host.
2. Complete the user-requested `hot-updater-agent` full-platform Lynx verification
   on `standalone-kysely`; record job ID, tested commit, binary identities,
   terminal conclusion and failed/passed scenarios. A queued job or dry run is
   not completion.
3. Run the current public API on all three frameworks per OS using unchanged
   release binaries within each A/B scenario. Capture A → B, an explicitly
   unavailable delivery origin, B confirmation, a second B restart, and exact
   resource identities. Keep separate Bundle and Release IDs in every receipt.
4. Map every PRD section 7 recovery/security/context scenario to current native
   tests and device evidence: B/C exclusions, cached-byte new Release, stale
   authorization, late/secondary/no-primary readiness, concurrent/interrupted
   installation, live resource lifetime and native-binary upgrade. Rerun where
   changed implementation or missing receipts leave the outcome unestablished.
5. Close the framework lazy-loading decision and refresh documentation only to
   the extent supported by those outcomes. Recheck shared RN regressions and
   package build/type/lint/test results at the final commit.

Stale documents to reconcile: PRD status/section 9 and all-Unverified table;
execution ledger's pre-Grok checkpoint; package README's provisional-build
wording; example README's G1-only positioning; OS evidence files that stop at
SDK1 or SDK3 preparation. Preserve their historical failures and hashes while
adding the final public contract and evidence links. Do not promote a historical
pass to the current commit without accounting for intervening changes.
