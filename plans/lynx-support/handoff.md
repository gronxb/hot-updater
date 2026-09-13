# Lynx support handoff and completion plan

Updated: 2026-09-13 (Asia/Seoul).

## Resume location

- Worktree: `/Users/gronxb/workspace/hot-updater-lynx`
- Branch: `codex/lynx-support`
- PRD decision HEAD: `01bb61260b932e20d3e3f8a3e8e957369f887e17`
- Pull request: [#1300: feat(lynx): add OTA updates for Lynx apps](https://github.com/gronxb/hot-updater/pull/1300)
- Previous Grok session: `01a09054-0a33-7111-a493-8ddacfda539a`
- The original checkout, `/Users/gronxb/workspace/hot-updater2`, contains earlier
  work and must be preserved. Run commands in the worktree above explicitly.

The Grok session ended at an earlier handoff commit. The English PRD decisions
were subsequently committed at the HEAD above; the Sol High implementation is
currently uncommitted in this worktree. Git and live job results take precedence
over either session summary. Do not start a second process against this worktree
while the current execution is active.

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

After PRD consolidation, the user requires **GPT-5.6 Sol / High** for implementation.
All previous-model agents were interrupted. Their partial files remain in the
worktree. Do not resume those agents for implementation; use the requested model
for the continuing primary task and any newly delegated subtasks.
The subagent that launches and waits for the full E2E job must use **GPT-5.6 Sol /
Low**. E2E failures return to Sol High implementation owners for diagnosis and
correction.

## Current implementation checkpoint

The September 13 PRD contains the user's final decisions: three equal framework
targets, real delta delivery, no Lynx migration of React Native's legacy metadata,
ordinary Sparkling scaffold configuration with library-owned native behavior,
engine-neutral common packages, and foreground managed-runtime recreation on
both OSes. Sol High agents implemented the main contract and are closing
adversarial findings before aggregate validation.

| Work area | Current implementation | Remaining evidence |
| --- | --- | --- |
| JS runtime | Check-time catalog authorization and nonretained compatibility validation; prepare-and-stage starts only in `updateBundle()`; atomic channel switch/reset; one-shot transition receipts; reload resolves after all managed views recreate and propagates failures | Final workspace checks and device behavior |
| Native artifacts | Strict archive and manifest verification, raw/Brotli changed files, real BSDIFF, verified fallback, cancellation, durable atomic publication, and later-launch verification on both OSes | Device delta receipts |
| Neutral delivery | Mandatory BuildPlugin artifacts, portable names, `patchAssetPath`, and `downloadCompression`; deterministic no-follow packaging, promotion, and fingerprint inputs; bounded artifact responses and URL resolution; archive-only compatibility for ambiguous older publications | Full RN/provider/server regression suite and current real deployment |
| Framework ownership | RN/Hermes build and fingerprint policy moved to `@hot-updater/react-native`; bare and Rock use it; Expo owns Expo fingerprint discovery | Final workspace regression checks |
| Sparkling integration | Optional packaged iOS/Android hosts own bridge, resources, readiness, recovery, leases, and all-container generation replacement | Run the lifecycle matrix on devices |
| Production examples | `SparklingGo` and Android `:app` contain configuration, registration, and packaged host/view attachment only; current native builds pass | Current device acceptance |
| Matrix harness | Separate iOS scheme and Android module reuse one binary per OS across React, Vue, and Octane; strict correlated receipts reject synthetic patch or stale-context evidence | Real six-cell device execution |
| Shared E2E | Explicit 25-scenario Lynx manifest equals the shared default minus only `metadata-v1-migration`; real delta scenarios remain | Commit runner/bot routing, restart the bot, and pass a new full job |

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

Focused checks passed for 141 Lynx JS tests, 10 CLI promotion tests, 66 Android
controller/installer tests, two Android Sparkling tests, 63 Swift tests with 13
environment-dependent skips, 308 E2E unit tests, and 65 matrix contract tests.
Both iOS schemes and both Android applications build in debug/release as
applicable. The server's 442 focused tests passed before the final 1.0.0 Supabase
schema fold and require one final rerun. These results do not replace full
workspace validation, the `hot-updater-agent` job, or the six device cells.

The E2E bot checkout is `/Users/gronxb/workspace/hot-updater-e2e-bot`. Its local
changes point the Lynx target at `e2e/lynx/default-scenario-names.json` and have
focused Bun tests. Review and commit only those files, then restart the daemon
before starting the next job. Verify that no job is running first.

No implementation commit or push has been made after the PRD decision HEAD. No
complete resumed E2E job or current six-cell matrix has passed. The active goal
therefore remains unfinished.

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

1. Finish the final Sol High adversarial pass over the packaged host, delta,
   delivery, and matrix changes. Resolve every actionable finding and rerun the
   affected focused tests.
2. Build both production scaffold targets and both matrix targets. Run workspace
   build, types, lint, unit, and integration checks, then update the component
   evidence with exact commands and results.
3. Commit explicit implementation paths without the six staged-only helpers,
   push the branch, and wait for Integration on that exact commit.
4. Review and commit the E2E bot's Lynx manifest routing, restart its daemon, and
   assign a Sol Low subagent to launch and wait for the full job below. Return any
   reproducible failure to a Sol High implementation owner and repeat until green.
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
