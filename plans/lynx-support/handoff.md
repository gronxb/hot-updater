# Lynx support handoff and completion plan

Updated: 2026-09-21 (Asia/Seoul).

## Resume location

- Worktree: `/Users/gronxb/workspace/hot-updater-lynx`
- Branch: `codex/lynx-support`
- PRD decision HEAD: `01bb61260b932e20d3e3f8a3e8e957369f887e17`
- Pull request: [#1300: feat(lynx): add OTA updates for Lynx apps](https://github.com/gronxb/hot-updater/pull/1300)
- Previous Grok session: `01a09054-0a33-7111-a493-8ddacfda539a`
- The original checkout, `/Users/gronxb/workspace/hot-updater2`, contains earlier
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
| Shared E2E            | The 25 applicable shared scenarios exclude only `metadata-v1-migration`; `sparkling-multipage-ota` adds the page-based Sparkling scenario, for 26 scenarios per OS                                                                                                             | Pass the queued full job on both OSes                                |

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

The pushed implementation is `348284787`. Focused package type checks,
workspace lint, and 207 recovery/driver E2E unit tests are green. Full job
`job-20260921204853-cw3i89` is queued on that commit. The active goal remains
unfinished until both 26-scenario platform runs pass and the final records are
reconciled.

## Current E2E campaign

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

1. Preserve the completed implementation and focused validation through commit
   `348284787`.
2. Build both production scaffold targets and both matrix targets. Run workspace
   build, types, lint, unit, and integration checks, then update the component
   evidence with exact commands and results.
3. Commit explicit implementation paths without the six staged-only helpers,
   push the branch, and wait for Integration on that exact commit.
4. Finish full job `job-20260921204853-cw3i89` on the corrected commit and
   diagnose any reproducible failure directly until green.
5. Run the separate public matrix with one unchanged binary per OS across React,
   Vue, and Octane. Require six strict receipts, then update the English PRD,
   evidence, and PR with the verified commit, binaries, job, and cell results.

```sh
cd /Users/gronxb/workspace/hot-updater-lynx
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
