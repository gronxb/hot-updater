# Lynx support handoff and completion plan

Updated: 2026-09-13 (Asia/Seoul).

## Resume location

- Worktree: `/Users/gronxb/workspace/hot-updater-lynx`
- Branch: `codex/lynx-support`
- Handoff HEAD: `84244ae429a899bf5631bbc99de3675a03fdaddf`
- Pull request: [#1300: feat(lynx): add OTA updates for Lynx apps](https://github.com/gronxb/hot-updater/pull/1300)
- Previous Grok session: `01a09054-0a33-7111-a493-8ddacfda539a`
- The original checkout, `/Users/gronxb/workspace/hot-updater2`, contains earlier
  work and must be preserved. Run commands in the worktree above explicitly.

The Grok session ended after committing and pushing the handoff HEAD. Its goal
paused because its usage balance was exhausted. Git and live job results take
precedence over the session summary's older HEAD. Do not start a second Grok
process against this worktree while Codex is continuing it.

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
passing scenarios, or weakened
assertions do not establish completion. The six framework/OS evidence obligations
remain separate from this shared runner gate.

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

After PRD consolidation, the user requires **GPT-5.6 Sol / High** for implementation.
All previous-model agents were interrupted. Their partial files remain in the
worktree. Do not resume those agents for implementation; use the requested model
for the continuing primary task and any newly delegated subtasks.

## Implementation handoff after PRD consolidation

The September 13 PRD now contains the user's decisions: three equal framework
targets, actual delta support, legacy RN metadata migration excluded, ordinary
Sparkling scaffold configuration with library-owned native implementation,
engine-neutral common packages, and foreground managed-runtime recreation on
both OSes. Implementation resumes with Sol High against these amended criteria.

The worktree has uncommitted changes after the handoff HEAD. Preserve them and
inspect before building: several agents were interrupted midway through delta
implementation. Earlier passing tests do not validate these partial changes.

| Work area | Preserved progress | Next implementation step |
| --- | --- | --- |
| Native startup/recovery | Removed premature iOS confirmation; restored both OSes' unconfirmed exclusions; guarded Android fatal termination | Retain these fixes while completing delta and generation reconstruction |
| E2E observations | Precise driver fields with 12 passing focused tests; truthful app snapshot/actions with 12 passing tests; example TypeScript passed | Finish shared screen-state/client regression tests and remove obsolete source-string assertions |
| JS artifact contract | Delta DTO/HTTP parser and tests partially edited in `packages/lynx/src` | Inspect parsing, forwarding, and tests; align both native module parsers |
| Android delta | Request/verifier/download helpers and private BSDIFF/assembler partially written | Finish installer preparation, publication, later-launch verification, controller/module plumbing, and native scenarios |
| iOS delta | Request/installer, stream decoding and BSDIFF SwiftPM/CocoaPods files partially written | Finish controller/module plumbing, compilation, native installation and adversarial tests |
| Neutral schema/server | Core `BundleManifest` fields and build-plugin artifact/fingerprint hooks added; `createBundleDiff` partially edited | Complete neutral packaging/server representation, integration-owned RN/Expo policies, native fingerprint, and regression tests |
| Sparkling integration | Source audit complete; implementation not started | Add packaged optional native host integration and reduce example native files to configuration; implement approved generation recreation |
| Agent suite | Some false success branches removed from control-server | Add Lynx default manifest excluding only metadata migration; update runner/tests and bot target manifest; adapt real delta/generation evidence |

The E2E bot checkout is `/Users/gronxb/workspace/hot-updater-e2e-bot`. It was clean
at model handoff. Its `src/e2e-target.ts` currently directs Lynx to the RN default
manifest; change only the Lynx manifest path after adding the explicit 25-scenario
manifest in the main repository. Read that checkout's AGENTS.md and preserve
unrelated daemon settings. Verify no running job before restarting the bot to
load any needed runner changes.

Native regression logs from before partial delta edits:

- `/tmp/lynx-handoff-swift-all.log`: 38 tests executed, 13 fixture-dependent skips,
  zero failures; focused local controller suite passed 13 tests.
- `/tmp/lynx-handoff-android-controller.log`: initial restored controller suite.
- `/tmp/lynx-handoff-android-fatal-guard.log`: 9 controller tests passed, including
  durable failure recording before termination and ignored stale contexts.

No implementation commit or push was made during this resumed Codex phase.
No complete resumed E2E job has passed. The active goal stays unfinished.

## Verified handoff state

| Area | State at handoff | Remaining work |
| --- | --- | --- |
| Runtime/build/native implementation | Present in `packages/lynx`; public API uses `HotUpdater.init`, `checkForUpdate`, `updateBundle`, and `reload` | Review current behavior against the original native safety requirements |
| Framework examples | React, Vue, and Octane example sources and iOS/Android hosts are present | Reconcile actual six-cell receipts with the current API and native implementation |
| PR and GitHub checks | PR #1300 is open; remote HEAD matches local HEAD; Integration and other checks succeeded | Repeat relevant checks after corrections |
| Agent full-platform E2E | Latest completed pre-handoff job failed on `9308f9c968b4cddc93ed33e82b889ec37c951ef9` | Obtain a successful job after correcting the implementation and reviewing assertion semantics |
| PRD/execution records | The existing execution ledger describes the earlier September 11 work | Preserve historical evidence and add current results without promoting old passes to current acceptance |

GitHub Integration at the handoff HEAD runs build, type checking, lint, unit tests,
and integration tests. Its success is verified through the PR check API. Native
device E2E is a separate gate.

## Last actual E2E failure

Job: `job-20260913015815-308xob`, full platform, `standalone-kysely`,
`examples/lynx/.env.hotupdater`. Finished with failure on 2026-09-13 at 11:18:21
KST. Its four child logs report:

| Child | Failed stage | Concrete observation |
| --- | --- | --- |
| Android s1 | `seed metadata-v1 state` | The helper tried to parse a missing RN-style `metadata.json` |
| iOS s1 | `seed metadata-v1 state` | The helper expected RN-style `bundles/metadata.json` in the Lynx store |
| Android s2 | `assert size-aware small manifest selection` | Expected a manifest diff; observed a full archive |
| iOS s2 | `wait force update automatic reload` | Target Bundle matched, but `verificationPending` remained true |

The dashboard's generic `ios-build` classification is not the diagnosis: child
logs contain the runtime/scenario failures above. Logs are retained under
`/Users/gronxb/.hot-updater-e2e-bot/logs/`; job checkout directories were removed
by the previous session and must not be assumed available.

The handoff commit attempted to address these failures. Independent native and
E2E reviewers immediately found that its iOS host confirmed startup before Lynx
view creation. A pre-existing 500 ms timer also invented content observation.
Both violate the PRD's native content plus application readiness requirement.
The first resumed job, `job-20260913030754-z5u7px`, was cancelled before accepting
any result so these issues can be corrected first.

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

1. Correct genuine iOS content/readiness observation; verify delayed readiness
   and pre-render failure remain unconfirmed and recover safely.
2. Resolve adversarial findings in E2E assertions and native lifecycle behavior.
   Implement real delta delivery; explicitly exclude only RN-specific legacy
   state migration. Move application-native implementation into the library's
   host integration and engine-specific build policy into its integration.
3. Run relevant local regressions, commit only agent-required implementation,
   push the branch, and wait for Integration on that commit.
4. Run the command below; inspect the exact job and its child stage logs. Fix
   reproducible failures and repeat until the full job succeeds with Lynx routing.
5. Reconcile all six framework/OS acceptance records, update English docs and PR
   with verified behavior, and close actionable adversarial findings. Record
   upstream limitations explicitly; do not count them as passes.

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
