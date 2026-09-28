# Lynx support handoff

Updated: 2026-09-29 (Asia/Seoul). The goal remains active and incomplete.

## Workspace and scope

- Worktree: `/Volumes/SSD_2TB/workspace/hot-updater-lynx`
- Branch: `codex/lynx-support`
- PR: [#1300](https://github.com/gronxb/hot-updater/pull/1300)
- PRD: `plans/lynx-support/prd.md` (English only).
- Preserve the original `hot-updater2` checkout, all six staged-only local
  helpers and untracked `examples/lynx/keys/`. Commit explicit paths with
  `git commit --only`; never merge or publish packages.
- Continue directly without subagents. Existing adversarial review remains
  authoritative input; see `adversarial-review.md`.

The user requires framework-independent Lynx support, actual Sparkling page
navigation, separate compiler bundles, real BSDIFF, and same-process recreation
of all managed pages on both OSes. Shared OTA/CLI/native helpers remain neutral;
RN/Hermes/Metro and Expo policy belong to their integrations. One server process
can serve isolated delivery projects with separate routes, updater instances,
DB/schema, storage and credentials. No framework enum is required. Prerelease
migrations remain 1.0.0.

Sparkling examples contain required library registration/configuration only.
The user explicitly approved the package-owned Fresco adaptation, with pinned
source/checksums/license and native fingerprint coverage. Standard pool setup,
uncompressed JNI and correct ELF/ZIP 16 KB alignment remain required.

## Current results

- Latest shared full run: `job-20260928211636-6hdwci`, **45/52**, iOS 20/26,
  Android 25/26. Native setup `6dc6352db`; runner checkout `1dcf23cf5`.
  See `evidence/shared-e2e-6hdwci.json`. Historical best remains **51/52**;
  prior completed `a5bb32fb3` run was 50/52.
- Public matrix: **0/6 validated cells**. `08163b59a` React/iOS completes all
  device phases and records 775 events. Final receipt replay identifies artifact
  transport metadata, detail readiness attribution, delayed interruption replay
  and a missing pre-confirm fatal recovery transition. See
  `evidence/public-matrix-08163b59a-failure.json`; offline analysis is not a pass.
- Current workspace: **3,933/3,933 units in 351 files** pass after the harness
  corrections. Prior native baseline: 27 build projects, 35 type projects and
  workspace lint passed; targeted lint/formatting pass for the latest edits.
  Swift: 138 executed, 13 skipped, zero failures after the new native regression.
- Current focused regressions cover the actual build normalizer/validator and
  explicit builtin Release identity. Read the final execution checkpoint for
  commands and exact subsequent test counts (latest: 112/112 across two matrix suites).
- Fresco: 28 ARM64/x86_64 libraries pass ELF/ZIP 16 KB checks; AAB reports
  PAGE_ALIGNMENT_16K. One unchanged matrix APK loads real images/fonts for
  React/Vue/Octane on a 16 KB ARM64 device (`evidence/fresco-16kb-smoke.json`).
- Isolated production-tarball CLI runs without RN/Expo, and authenticated
  local delivery projects pass namespace/signature checks. See
  `evidence/isolated-cli-flow.json` and `isolated-cli-neutrality.json`.

## Latest corrections and unresolved diagnosis

`dad654d45` captures the actual pending pageAttemptId before iOS lifecycle
fatal classification, prepares a new launch identity for crash relaunch, resets
only the changed identity's runtime epoch, and refreshes the iOS fingerprint.
Its iOS fingerprint is
`ad84b7ed81a63a2a1f954d756f8c3b876281fdb501a4c963efd84630ad1edd42`.
These changes address the previous final matrix attribution failure, four shared
iOS epoch failures and the stale fingerprint failure. Fresh shared proof is needed.

`08163b59a` retains the compiler's canonical sorted resource graph and preserves
explicit releaseId=null in metadata waits. Null means builtin recovery; only
undefined may infer a deployed Release. The full shared job
`job-20260928230647-4uc5ag` is queued; verify its resolved source before pushing
while setup/runner checkouts are in progress.

The subsequent correction compares all eight installed payload hashes/sizes,
binds each transport manifest to its own digest, and reserves jsReadySequence
for the primary context. It replays iOS interruption terminals before stack
evaluation and retains the failed pending startup selection for exactly one
RECOVERED response. A Swift scenario confirms B, fails unconfirmed C's detail,
and requires B recovery with C crash/suppression history and C-to-B provenance.
Swift: 138 executed, 13 skipped, zero failures. The iOS fingerprint is now
`3cec7835e41b5684ee038ffbe12e7802b3f85aae7199810412b50b23dc57d4c7`;
Android is unchanged. Fresh native builds are mandatory.

The iOS shared multipage case admitted 16 pages but emitted no nativeBack after
one gesture. Its intact 203-event journal rules out truncation. A manual check
on the unchanged dad654d45 matrix binary observes every native back depth from
15 through 1; the shared-app failure is still unresolved until a full rerun.
Do not introduce speculative native code or blind repeated gestures.

## Remaining acceptance

1. Push corrections and keep HEAD fixed while the full shared job creates its
   setup and runner worktrees. Run `hot-updater-agent verify -platform full
   -profile standalone-kysely -env-target examples/lynx/.env.hotupdater`.
   Require all 26 scenarios per OS; only RN metadata migration is excluded.
2. Build native matrix artifacts from the same committed source and finish all
   six React/Vue/Octane × iOS/Android cells. Do not edit, reinstall or manually
   interact with devices while matrix execution is live. Failed receipts are
   evidence, never passing cells.
3. Production iOS `08163b59a` smoke passed with its installed full app tree
   verified and diagnostics absent. Repeat after the subsequent native changes;
   these endpoint-unconfigured smokes do not establish network OTA.
4. Android's original black screenshot is explained by keyguard/display sleep,
   a stopped/nonvisible root and no focused window. Preserve the original plus
   `production-scaffold-android-keyguard-diagnosis.json` and unchanged-APK timed
   backs. The initiator of keyguard was not captured; no native workaround.
5. Keep pinned Vue/Octane compiler lazy-output limitations explicit. Core
   external/dynamic component proof does not establish compiler lazy bundles.
6. Update PRD, execution evidence and PR accurately; complete the goal only
   when every required gate is met.

## Devices and retained local state

- Dedicated matrix iOS: `3A0A8EB7-9381-4CFD-B002-5B16F539D445`.
- Dedicated matrix Android: `emulator-5560`, page size 16384.
- Bot devices 5554/5556 and iOS 0368…/10AB… belong to queued jobs. Do not
  interact with them during jobs or interrupt unrelated work.
- Latest local checkpoint: `/tmp/lynx-latest-checkpoint.json`; verify live
  processes before relying on its session IDs.
- Latest matrix output: `/tmp/lynx-08163b59a-public-matrix/` and retained raw
  failure `/tmp/lynx-08163b59a-matrix-failure/`.
- Shared journals: `/tmp/lynx-7cc24042b-native-journals/`.
- Native builds use bounded tools: prepend `/tmp/lynx-bounded-native-tools`
  to PATH, set RAYON_NUM_THREADS=2, UV_THREADPOOL_SIZE=2 and
  GRADLE_OPTS=-Dorg.gradle.workers.max=2; use nice 15.
- Six preserved staged helpers have the byte-identical baseline patch at
  `/tmp/lynx-preserved-staged-before-native-neutral.patch`.

Read the final sections of `execution.md` for chronology and exact evidence.
