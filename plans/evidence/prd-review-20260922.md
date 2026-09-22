# PRD review and v1 native cleanup — 2026-09-22

Review baseline: `162aaa843`, after merging `origin/next` at `d99530b1e`.
Reviewers: two GPT-5.6 Sol / Medium subagents, with the coordinating agent
reproducing findings and reviewing the final changes.

## Product verdict

The intended architecture is implemented: a verified target manifest defines a
complete OTA directory; matching builtin files are copied into staging, and only
missing or different files need the network. No mandatory embedded manifest or
whole-package copy is required. Every original remains available. Subsequent
OTA updates can use a verified binary patch; the first changed builtin Hermes
file still needs its original unless the actual native base is registered.

The optional tar.br path is selected after local reuse according to the signed
size contract, with one individual-file fallback. There is no public compression
strategy or ZIP/gzip OTA decoder. APK ZIP entry reading and bsdiff's internal
bzip2 remain necessary.

Current acceptance is reopened for the fixes below. Historical standalone E2E
success at `797338cd0` does not establish success for the new revision.

## Confirmed findings and resolution

1. **Artifact authentication:** the route was renamed `artifactV1`, but the
   authentication predicate still tested `artifact`. A regression test reproduced
   missing credentials returning 200. The predicate now protects the versioned
   route; tests cover missing/invalid/valid credentials and an unavailable
   authenticator. Artifact resolution occurs only for valid credentials.
2. **Activation persistence:** native installation could report success despite
   failing to save metadata, and a preference could independently activate the
   uncommitted directory. Durable metadata now authorizes launch, and failed
   metadata writes fail installation without activating the target.
3. **Replacement promotion:** deleting an existing final directory before moving
   staging could destroy a working bundle if the move failed. Both platforms use
   an atomic sibling backup/rename sequence, restore on failure, and recover
   interrupted promotions on startup. A corrupt final directory cannot discard
   the retained backup; manifest and all hashes are revalidated first.
4. **Patch failure evidence:** iOS tests now exercise missing patches, corrupted
   patches, and a hash-valid invalid patch format. Each install downloads the
   target original in the same attempt and verifies the resulting bytes.

The proposed Supabase overwrite concern was withdrawn after rebuttal: the Storage
contract already permits replacement, all other providers do so, and normal
deploys generate fresh Bundle IDs. No separate corruption scenario was
demonstrated. The previously verified idempotent shared-asset upload fix remains.

## Native cleanup

- Removed `BUNDLE_ID` compatibility lookup and manifestless OTA discovery/launch.
- Removed preference-only metadata initialization and untracked launch fallback.
- Removed unused archive-era outer progress byte fields; retained actual per-file
  byte counters and the public progress callback.
- Removed obsolete iOS overloads, unused task arrays/constants, per-download
  notifications and observer bookkeeping.
- Removed iOS task JSON persistence that had no recovery consumer. The actual
  background URLSession and download completion/progress callbacks remain.
- Simplified redundant Android bridge parsing and removed the unused TypeScript
  bridge descriptor type. Retained both supported React Native architectures.
- Retained catalog/selection guards, builtin state, isolation invalidation,
  manifest-backed metadata migration, and crash recovery. These are active v1
  behaviors even where internal names mention legacy state.

## Verification

- Build: 26 workspace projects passed.
- Typecheck: 34 workspace projects passed.
- Lint and diff whitespace checks passed.
- Unit suite: 2,762 passed; three tests timed out under parallel local load.
  A serial rerun of both affected files passed all 16 tests with unchanged
  timeouts, covering both large HBC patches and scaffold extraction.
- Swift: 49 Swift Testing cases and 3 XCTest cases passed, including fault
  injection, restart recovery and patch fallback.
- iOS Release Pod compilation passed for the current source after regenerating
  stale Pods and placing build outputs outside the codegen input directory.
- Integration suite: 386 passed; two DynamoDB tests timed out under parallel
  local load. A serial rerun of that file passed all 57 tests with unchanged
  timeouts. No assertion failure remains.
- Android: 69 Debug and 69 Release unit tests passed, with old-architecture
  Debug/Release and new-architecture Debug Kotlin compilation. Local ktlint
  initially passed, but CI's pinned ktlint 1.3.1 rejected two condition-wrapping
  positions. The formatting-only correction passes ktlint 1.3.1 across all
  Android Kotlin sources; E2E fingerprints were regenerated afterward.
  Android lint passed with the installed React Native version's minSdk 24; the
  standalone lint configuration defaults to an incompatible minSdk 21.
- The v0.85.0 Release E2E app fingerprints were regenerated from the final native
  source and injected into its iOS and Android configuration.
- No new-revision full Release E2E success is claimed here. The nine jobs pinned
  to `162aaa843` were intentionally superseded after these source changes.

## Remote runtime reconciliation

All four provider runtimes were extracted from the current locally built
workspace using `infra scaffold`. Existing deployment configuration, resource
identities, endpoints, signing keys and data were preserved; this authentication
fix requires no schema change. The unreleased 1.0.0 upgrade guide now explicitly
documents the manifest protocol, direct initial-schema updates, native rebuild
and authentication checks.

Cloudflare, Supabase, Firebase and AWS each passed real remote probes: missing
and invalid API keys returned 401, a valid key returned the manifest artifact
response, and an actual asset download matched its expected SHA-256. AWS uses
Lambda version 17; CloudFront status is Deployed.
These probes do not replace native signature verification or device E2E.

Private reconciliation logs, deployment details and test logs remain in
`/Users/gronxb/.hot-updater-e2e-bot/reconciliations/pr-1319/`; do not publish
credentials or signed artifact URLs from those records.
