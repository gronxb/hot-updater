# PRD: Builtin file reuse and unified manifest-based OTA delivery

## 1. Status and execution contract

- Created: 2026-09-20.
- Status: The core implementation and performance gates passed at `797338cd0`, including five standalone E2E profiles; results are preserved in `evidence/standalone-tar-br.{md,json}`. A renewed Sol Medium review on 2026-09-22 found artifact authentication and final-promotion failure gaps. The follow-up fixes and v1 native cleanup reopen final acceptance until the new revision passes CI and all nine requested E2E profiles. See `evidence/prd-review-20260922.md`.
- Current merge baseline: `origin/next` at `d99530b1e`, merged in `4c43e3459`. Pre-review HEAD: `162aaa843` (runtime code from `d78727c48`). Earlier results do not verify the follow-up native changes.
- Merge baseline for that acceptance: `origin/next` at `333188ab939769609913529004d6c0d15474ad03`, merged in `1aa201bbd`. Historical code references in section 4 use the initial baseline `ec78756926cac3b23ca32c1d3acefe28d2ebb7ab`.
- Working directory: `/Users/gronxb/.codex/worktrees/builtin-manifest-v1/hot-updater`.
- Branch: `feature/builtin-manifest-v1`.
- Subagent model: `gpt-5.6-sol`, reasoning effort `medium`.
- This document and `plans/README.md` govern subsequent execution. They must be usable without the conversation history.
- Do not modify the existing main checkout or the separate Insights worktree.
- The user explicitly requested adversarial subagent agreement. Record the supporting and opposing reviews and rebuttals from the two Sol Medium reviewers in `evidence/tar-br-consensus.md`.
- Implementation, local verification, PR pushes/updates, and standalone E2E requests were authorized. That initial authorization did not include separate GitHub/Linear discussions, production infrastructure changes, package publication, or merging the PR.
- Preserve reviewable code diffs, change documentation, measurements, and test evidence.

### Related requirements

- [GitHub #1315](https://github.com/gronxb/hot-updater/issues/1315): The cost of downloading unchanged images and fonts again during the first OTA after a store installation.
- [HOT-18](https://linear.app/hot-updater/issue/HOT-18): Use the builtin bundle as an OTA diff base.
- [HOT-19](https://linear.app/hot-updater/issue/HOT-19): Remove `compressStrategy` and simplify compression around Brotli.
- The user's reference to `updateStrategy` was a mix-up with `compressStrategy`. Preserve `appVersion`/`fingerprint`.
- The existing tickets are recorded as non-blocking for the 1.0 release. This document records implementation approval without independently changing the release schedule.

## 2. Problem and goals

Before this change, the first OTA downloads a full archive without reusing builtin files. Subsequent OTAs can reuse manifest files and apply Hermes binary patches, but recovery from some failures, including local file corruption, depends on a full archive.

The goal is to safely reuse installed builtin files whose bytes match the target, without requiring a manifest to be embedded at build time. Installation and recovery must be complete using only the manifest and individual original files. Provide tar.br as the sole optional full-download path to reduce request overhead for large changes, and remove `compressStrategy`.

Core invariant:

> An update can complete using only a verified target manifest and every original file it describes, even when no local base or binary patch is available.

### Successful user experience

1. Install an app built through the normal native build process. Do not add a mandatory manifest-injection script or server-upload step.
2. During the first OTA containing a JS change, native code locates corresponding builtin assets and checks their actual hashes.
3. Matching files require no download. Download the complete original for each changed, missing, or transformed file.
4. Subsequent OTAs use the same installer. A beneficial Hermes patch is an additional optimization.
5. If an update fails, preserve the working version. Retain existing catalog selection and crash recovery rules.
6. Users do not choose archive/diff delivery or a compression format.

## 3. Scope

### Included in this implementation

- A limited resolver mapping iOS/Android builtin files to target manifest paths.
- An asynchronous, lazy reuse index that reads only needed files, with a regenerable local cache.
- Complete manifest-based installation when the builtin base is unregistered or no local manifest exists.
- An original-file download contract for every target file and per-file recovery when local reuse fails.
- Existing Hermes patches between OTA bundles, with original-file recovery after patch failure.
- Safe staging, retries, interrupted-install handling, and crash rollback.
- Reuse and performance verification using actual Release artifacts.
- Creation, delivery, installation, selection, and failure recovery for the sole tar.br archive path. Remove ZIP/tar.gz/tar.bz, automatic format detection, and `compressStrategy`.
- Necessary SDK/CLI/server/provider schema, documentation, example, E2E, and changeset updates.

### Deferred optimization

**Registering native artifacts to generate the first builtin Hermes → OTA binary patch is not an acceptance condition for this work.** Builtin file reuse provides a first-OTA diff without that feature. Define the extension boundary here, but do not add a registration CLI or automatic CI-upload feature.

The future feature requires the deployment side to retain the final Hermes bytes included in the actual native build. A device-generated hash or manifest alone cannot produce a patch. An app without a registered base must update successfully by downloading the first complete Hermes file.

### Out of scope

- Changes to `updateStrategy`, runtime compatibility, cohorts, channels, Release chronology, or catalog selection policy.
- Replacing the native asset resolver globally or bypassing verification based on semantic image equality.
- Duplicating all builtin images in another directory or copying all of them into app storage.
- Removing compression from the APK/IPA itself. Limit full OTA delivery to tar.br.
- New archive/pack formats beyond tar.br, a general-purpose cache framework, or a new plugin API for every bundler.
- Unconditionally recompressing every transferred file with Brotli. Images and other files without a compression benefit may use raw delivery.
- Changing the selected diff algorithm. Do not confuse internal `bsdiff` compression or the `bz2` dependency with removing OTA TAR support.
- Bulk deletion of existing production Storage archives or database data.
- Refactoring adjacent Insights work.

## 4. Baseline behavior and code references

The line numbers below refer to the baseline SHA. Compare them with live code before making changes.

| File                                                                                         | Baseline role and reason for change                                                                                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/react-native/src/native.ts:631`                                                    | Synchronous `getManifest()` and session cache. Empty manifests are cached too; do not hide slow initialization here.      |
| `packages/react-native/src/checkForUpdate.ts:360`                                            | Resolves artifacts and installs after Release selection. Preserve catalog guards/receipts.                                |
| `packages/react-native/src/httpClient.ts:243`                                                | Calls `/artifacts/:targetBundleId/from/:currentBundleId`. Connect the complete file-descriptor contract.                  |
| `packages/react-native/android/src/main/java/com/hotupdater/BundleFileStorageService.kt:893` | Rejects manifest installation without an existing OTA directory and manifest.                                             |
| Same file: `:1473`, `:1558`, `:1894`                                                         | A null archive URL means builtin reset; diff failure triggers archive fallback; missing/corrupt reused files throw.       |
| `packages/react-native/ios/HotUpdater/Internal/BundleFileStorageService.swift:1020`          | Assumes an existing OTA in the same way. Processes files sequentially after `:2251`.                                      |
| `packages/server/src/db/updateArtifacts.ts:286`                                              | Omits the original descriptor when server manifests have matching hashes. This cannot recover from local corruption.      |
| Same file: `:395`, `:507`                                                                    | Preserve patch-versus-original size comparison, but remove the archive-versus-manifest size comparison.                   |
| `packages/core/src/types.ts:34`                                                              | Bundle requires archive hash/URI/size while the manifest is optional. Reverse that emphasis in the final contract.        |
| `plugins/plugin-core/src/types/databaseRows.ts:17`                                           | Archive-centric BundleRow. Providers and schemas need a consistent transition.                                            |
| `plugins/plugin-core/src/assetStorageLayout.ts`                                              | Reuse content-addressed file paths and `.bundle.br` support.                                                              |
| `packages/hot-updater/src/commands/deploy.ts:899`                                            | Archive selection/creation coexists with manifest and individual-file uploads.                                            |
| `packages/hot-updater/src/utils/bundleManifest.ts`                                           | Distinguishes installed bytes (`fileHash`) from transferred bytes (`downloadFileHash`/size).                              |
| `packages/server/src/db/createBundleDiff.ts:290`                                             | Existing patch generation also reads actual base and target bytes.                                                        |
| `docs/architecture/release-catalog-plan.md`                                                  | Bundle represents immutable bytes; Release represents deployment intent. Do not create a fake Release for a builtin base. |

Relevant baseline code:

```kotlin
if (hasManifestDrivenArtifacts && canUseManifestDrivenInstall()) {
    // manifest installer
}
```

```ts
const currentAsset = currentManifest?.assets[assetPath];
if (currentAsset?.fileHash === asset.fileHash) {
  return []; // The file's download descriptor is currently omitted.
}
```

Follow the existing test style in `packages/server/src/db/updateArtifacts.spec.ts`, Android's `BundleFileStorageServiceTest.kt`, and iOS's `BundleFileStorageServiceTests.swift`. Verify actual outcomes for the scenarios below instead of merely testing deletion or mirroring the implementation.

## 5. Design decisions

### 5.1 The target manifest and builtin index are different data

- The target manifest defines the complete installed file set and its hashes. Verify signatures when existing signing settings require them.
- The builtin index contains only the subset of files the device could read. It must not pose as a complete build manifest or a canonical server Bundle.
- Do not replace the server manifest's `bundleId`, current launch selection, or `MIN_BUNDLE_ID` with a new index ID.
- The index needs neither permanent server-facing URLs nor signatures. Trust always comes from the target manifest and the bytes actually read.
- Store the complete target manifest in the new OTA directory, not the partial index.

### 5.2 Lazy creation and storage

Do not write a manifest into the installed app bundle/APK. Atomically store the index in a dedicated builtin namespace within app-private writable storage.

1. Download and verify the target manifest.
2. Look for a candidate in the existing OTA for each file first.
3. If that candidate is absent or invalid, query only the corresponding path through the builtin resolver.
4. Hash the actual bytes as a stream and reuse them only when they match the target.
5. Cache the verified `logicalPath → native source locator + observed hash` mapping.
6. Treat absent files and unsupported representations as ordinary cache misses, then download the original.

A separate public `ensureManifest()` API is unnecessary. Implement this as an asynchronous preparation stage inside the installer. Do not scan or hash everything in synchronous `getManifest()` or on the JS/main thread. An initially empty getter result must not permanently disable builtin lookup during a later installation.

Downloaded installation must remain possible when the cache is corrupt, deleted, or unwritable. A cache hint alone must not authorize a copy: verify the final staging file against the target hash. Invalidate the cache on native package replacement and schema changes; neither `appVersion` nor fingerprint alone identifies a package. Consider OS installation/package revision, the identity of the builtin bundle actually loaded, and the split set. Hash HBC asynchronously when first needed.

Do not permanently remove an existing candidate just because another target hash was requested. Do not permanently negative-cache missing files whose availability can change after split installation. Revalidate actual sources even when an old index exists, so stale cache entries cannot authorize incorrect bytes.

### 5.3 Builtin file resolver

**iOS**

- Use the builtin bundle URL actually selected by the app. Preserve brownfield bundle arguments rather than assuming `Bundle.main` in every case.
- Map default `main.jsbundle` to logical `index.ios.bundle`. Reuse the existing source of bundle-location information when custom locations are supported.
- Resolve ordinary Metro file assets only through paths relative to the bundle.
- Treat asset-catalog entries without accessible original bytes as unsupported/missing. Image decoding and re-encoding must not replace target-hash verification.

**Android**

- Read default HBC from `AssetManager` at `index.android.bundle`.
- Map Metro-generated `drawable-*` and `raw` paths to resources actually installed. Do not assume only the base APK exists.
- Support stream/resource locators. Do not impose the existing installer's ordinary-`File` assumption on builtin sources.
- Do not choose an arbitrary density or re-encode images. Reuse only the exact candidate corresponding to the requested logical path.
- Download the original when packaging-time PNG processing, resource renaming, or an uninstalled split makes the bytes unavailable or different.
- APK entry lookup reads builtin resources. Do not remove it as if it were the OTA ZIP download/extraction path.

Remote paths must pass existing path traversal checks on both platforms. Do not let a remote manifest specify arbitrary native locators. Copy reused files into the target OTA staging directory; do not create a complete package copy or shared mutable hardlinks.

### 5.4 Manifest-based delivery contract

For simplicity and recoverability, **provide an original-file descriptor for every target asset**. Include files even when the server believes they match the current base. The client decides which files have changed under this contract.

- The artifact response includes the target manifest URL/hash and a complete file-descriptor map.
- Name the complete map `assets`. Do not silently redefine `changedAssets` to mean all files.
- Each entry contains the target `fileHash`, an original `file` descriptor, and an optional `patch`.
- The original descriptor's URL is required. Do not publish a new artifact containing only a patch without its original.
- Reject installation when the manifest and descriptor file sets or hashes disagree. Do not interpret missing data as builtin reset.
- Preserve the distinction between `fileHash` for restored file bytes and `downloadFileHash` for the actual transferred representation, including compression.
- For binary patches, verify the base hash, patch hash, and final target hash. Recover by downloading that file's original on failure.
- Select the original when the patch is at least as large as the original's compressed transfer representation.
- A complete-file response must be available even when the base Bundle is unregistered on the server. The builtin index does not need to be uploaded.
- Do not put device indexes into static Release catalogs or change update checks to use device-specific cache keys.

Version the wire change explicitly. v1 has not been officially released, so finalize the manifest-based contract directly without a backward-compatibility layer. The new SDK validates the response version and descriptors. Unsupported server responses must not become builtin resets or empty successes.

The wire boundary finalized in M1 is:

- The new SDK calls only `/artifacts/v1/:targetBundleId/from/:currentBundleId`.
- The versioned artifact route uses the same configured client API-key authentication as Release Catalog requests. Missing/invalid credentials must not resolve artifact URLs; authentication-service errors fail closed.
- The response provides `artifactProtocolVersion: 1`, the target manifest URL/hash, and `assets` with required original descriptors for every target file. Optional `archiveUrl` points to the fixed tar.br object; only the verified manifest is authoritative for its hash and sizes. `patch.byteSize` is a cost-comparison hint.
- The unversioned `/artifacts/:targetBundleId/from/:currentBundleId` endpoint is unsupported. The server and SDK expose/call only the versioned v1 endpoint.
- Servers unable to read manifests do not produce v1 artifacts. The new SDK treats endpoint 404s or missing versions/descriptors as protocol incompatibility, never as builtin reset.

### 5.5 Installation, failure, and concurrency

The per-file order is `verified existing OTA reuse → verified builtin reuse → beneficial patch → original file`. Only absent/mismatched local candidates and failed patch optimizations may become ordinary misses. A target-manifest signature failure or final installed-file hash mismatch must never count as success.

- Atomically promote staging only after verifying every target file.
- Preserve an existing target under a sibling install backup until activation metadata commits. Restore it when promotion or metadata persistence fails, and recover interrupted renames before launch. Do not fall back to a non-atomic final-directory copy.
- Durable metadata authorizes OTA launch. A cached preference, a `BUNDLE_ID` file, or a directory without the required manifest cannot independently activate a downloaded bundle.
- Do not retain old files absent from the manifest in the new directory.
- Preserve catalog guards and selection receipts at installation start and completion.
- On failure, retain stable/builtin state, crash history, and the highest catalog generation.
- Allow reuse of verified completed files after interruption. Do not trust incomplete files.
- Use a small fixed concurrency limit for network file downloads without adding a public option. Reuse an existing utility where available.
- Count only files actually downloaded in download progress, but avoid appearing stalled during local preparation/verification. Reset previous file progress when a new installation starts.
- Disk exhaustion must fail without destroying the working bundle.

### 5.6 Extension boundary for builtin Hermes patches

Preserve existing OTA-to-OTA patches and reuse identical builtin Hermes files. When the initial builtin HBC changes and no registered patch exists, downloading the complete `.bundle.br` is the correct behavior.

A future registration feature must retain the original HBC from the final native build. Matching appVersion/fingerprint is not proof of matching bytes, and registering a builtin base is not publishing an OTA Release. Do not document that sending only a hash from an already distributed app lets the server generate a patch.

### 5.7 The sole tar.br archive path and final v1 contract

The manifest is the sole authority for the installed result. New deploys and Bundle copies create `bundle.tar.br` alongside all content-addressed originals and optional patches. The archive contains only sorted target regular files and excludes `manifest.json`. After creating the archive, add this metadata to the final manifest and sign the entire manifest:

```ts
archive?: {
  downloadFileHash: string; // SHA-256 of compressed bundle.tar.br
  downloadByteSize: number; // Compressed transfer size
  tarByteSize: number;      // Exact size of the decompressed TAR stream
};
// Each assets[path] also records the logical file's byteSize.
```

- The archive is the fixed sibling `bundle.tar.br` of `bundles/<id>/manifest.json`. The server validates the canonical Storage URI and resolves its URL; native code does not guess by manipulating signed URL strings. Omit archiveUrl if resolution fails.
- Keep Bundle/DB/provider contracts centered on the manifest. Do not restore archive-specific database columns, metadata used to bypass the schema, or old-row compatibility paths. Continue directly modifying the initial 1.0.0 schemas/migrations; the optional archive path itself requires no additional database change.
- User configuration has no `compressStrategy` or archive/diff selector. Reject previous options.
- Fix TAR metadata (mtime/mode/uid/gid) and file ordering. Publish the Bundle/Release only after the archive and all originals finish uploading. Archive creation/upload failure fails deployment. Record generation CPU/temporary disk costs and the storage cost of one complete compressed object per release.
- Storage prune/delete includes the archive under the canonical Bundle prefix.

**Transport selection** happens once in native code, after manifest/complete-descriptor verification and reuse from existing staging, OTA, and builtin sources, but before individual downloads begin.

1. Use individual transfers if fewer than two network files remain.
2. Read each file's signed `downloadByteSize` and, when a patch exists, `patch.byteSize`.
3. The estimated transfer for each file is `min(original size, offered patch size)`. Even when the patch base is unavailable locally, this optimistic lower bound makes archive selection conservative.
4. Use individual transfers when required sizes or archive/logical-file bounds are missing or invalid, or when sums overflow. Do not introduce arbitrary RTT, bandwidth, file-count weights, or user thresholds.
5. Select the archive only when `archive.downloadByteSize <= sum of estimated individual transfer sizes`.
6. Allow one exception when every target file needs the network and no patch is offered: select the archive if `TAR framing = tarByteSize - Σ asset.byteSize` is nonnegative and `archive.downloadByteSize <= sum of estimated individual transfer sizes + TAR framing`. Every value and sum must fit the JavaScript safe-integer range. This avoids a request explosion caused solely by TAR format overhead for many incompressible files. If reuse or a patch is present, apply only the strict size comparison in step 5.
7. Bound the additional transfer allowance by the actual signed TAR framing. Do not claim guaranteed minimum latency or smaller payloads on every normal path. Measure the actual native installer with identical inputs, both with and without bandwidth limits.

**Installation and failure:** Download the archive once into separate scratch storage. Verify its compressed size and SHA-256 before Brotli decompression and TAR extraction. Enforce `tarByteSize` and per-file `byteSize` bounds. Validate normalized relative paths, absence of duplicates, the exact file set, and clean stream termination. Reject symlinks, hardlinks, devices, unsupported entries, and path traversal instead of silently skipping them. Apply existing manifest hash/signature checks to every extracted file before incorporating it into staging. Store the verified manifest separately and preserve atomic promotion, catalog guards, and stable/crash recovery.

If archive download, hashing, decompression, or file verification fails, discard all archive scratch and execute the previously computed individual-file plan once. Do not reuse partially extracted files from the failed archive; preserve already verified local reuse. Do not loop back to the archive or run both paths concurrently. Manifest or descriptor contract failures fail immediately. Recovery can duplicate transferred bytes, so the normal-path size bound does not apply. Patch failure still recovers only through that file's original.

**Native simplification:** Keep only a direct tar.br path sharing the existing individual-file Brotli decoder. Do not restore ZIP/gzip/bzip2 OTA extraction, automatic format detection, DecompressionStrategy/registry/factory layers, or compression negotiation. Retain bsdiff's internal bzip2 and the builtin APK reader.

## 6. Implementation order and verification gates

Update `plans/README.md` after completing each stage. Evidence is required beyond checked boxes. When a technical blocker occurs, continue independent stages, but do not mark the failed gate as passed.

### M0 — Release packaging investigation and minimal behavior verification

1. Confirm the baseline, branch, and AGENTS instructions. Record baseline CI/E2E commands.
2. Prepare a first-OTA JS-only fixture and builtin PNG/font fixtures in `examples/v0.85.0`. Preserve normal Release settings.
3. Inspect the actual iOS Release app bundle and the device-specific split APKs generated and installed from the Android AAB. A universal APK is not a substitute for split verification.
4. Record each file's logical OTA path, package source, observed SHA256, target SHA256, reuse eligibility, and reason.
5. Verify the minimal behavior: reuse identical PNG/font bytes preserved by packaging; download genuinely transformed PNGs, missing densities, and changed files.

**Deliverables:** `plans/evidence/builtin-packaging.md` and machine-readable result JSON, including build SHA, build settings, device/split configuration, compared hashes, and test commands. Do not commit complete app binaries or secrets.

**Gate:** Prove byte-identical builtin asset reuse and downloads for missing/mismatched files on both platforms. If stock packaging makes image reuse impractical, disclose that result instead of silently forcing different packaging options. Continue with supported fonts/ordinary files and separately report changes needed to guarantee image reuse.

### M1 — Complete original descriptors and installation without a base

1. Finalize the artifact wire version and unsupported unversioned boundary, and record the actual decision here.
2. Update core, the server artifact resolver, and SDK HTTP/native bridges to provide an original-file path for every target file.
3. Remove the native installer's existing-OTA-manifest prerequisite and the coupling between null archive URLs and reset. Distinguish explicit install and builtin transitions.
4. Recover corrupt/missing local files by downloading their originals. Recover patch failures per file as well.
5. Verify complete installation from an empty state using the manifest, rejection of inconsistent responses, and absence of the unversioned endpoint.

**Gate:** Server artifact, SDK/native bridge, and Swift/Android storage tests pass; installation without a base makes no archive request.

### M2 — Builtin resolver and lazy index integration

1. Add a small builtin resolver on each platform. Match the existing storage service interface without introducing a general-purpose framework.
2. Prepare the index only in the asynchronous installer. Implement package identity, cache schema, atomic persistence, and invalidation.
3. Verify actual source bytes and copy only needed files into staging.
4. Cover empty getter caches, corrupt/deleted caches, app replacement, split changes, and concurrent update calls.
5. Verify consecutive updates and crash rollback through the same installer after the initial OTA.

**Gate:** Identical builtin files incur zero network requests/bytes during the first OTA. Final hashes, the app screen, and Bundle ID must match the target. Log messages alone are insufficient evidence.

Release E2E shard dependency symlinks can make native-build and OTA dependency-asset paths differ. The app-local PNG/font reuse scenario explicitly omits optional `archiveUrl` and also verifies zero archive requests. This isolates reuse and must not be reported as evidence of default automatic selection. Verify automatic selection through native JS-only/patch benchmarks with an archive URL and Release scenarios for normal archives and corrupt-archive fallback.

### M3 — Optional tar.br delivery and transfer-cost verification

1. Compare the baseline archive version and new installer using identical artifacts and network conditions.
2. Cover the first JS-only OTA, small OTA-to-OTA changes, an empty base, and complete changes involving many small files.
3. Record downloaded bytes/request counts, preparation/hashing/installation time, peak temporary disk, and memory. State repetition counts, devices, and network conditions; do not label a few runs as p95.
4. Address avoidable bottlenecks in complete-change paths through bounded concurrency, verified file reuse, and per-file retries. Do not invent a new pack format without measurement evidence.
5. Implement section 5.7's sole tar.br contract across deploy/copy/server/SDK/native code without reintroducing ZIP/gzip/compression choices.
6. Update archive assumptions in documentation, examples, progress, and E2E, and write the changeset.

**Gate:** Every correctness scenario passes. The JS-only fixture must eliminate exactly the downloads for reusable files. If complete-change scenarios are consistently slower than baseline, document the size/request-count causes, improve the bottleneck, and measure again. Do not accept the transport contract while serious performance regressions or protocol issues remain unresolved. Do not declare success using unobserved figures or arbitrary SLOs.

### M4 — Integration verification and acceptance

Verify iOS/Android E2E with the changed native build and every affected provider contract. Convert the original archive→diff scenarios into builtin→manifest and patch→original fallback scenarios instead of merely deleting them. Existing catalog ordering, scope switching, recovery, and signing scenarios must continue to pass.

**Gate:** Record actual results for every completion condition and verification command below. On completion, report the changes, test results, remaining limitations, and working directory to the user.

## 7. Required scenarios

| ID  | Scenario                                                                                  | Observable outcome                                                                                               |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A01 | First install, unregistered server base, JS-only change                                   | Identical builtin files transfer 0 bytes; original HBC downloads and runs correctly                              |
| A02 | Neither a local manifest nor a builtin index exists                                       | Successful installation through lazy lookup or originals alone                                                   |
| A03 | Packaging transforms a builtin PNG                                                        | Actual hash mismatch; download that file; final hash matches                                                     |
| A04 | Some Android density splits are absent                                                    | Download only missing files; never substitute another density                                                    |
| A05 | iOS asset catalog or unsupported asset                                                    | Safe miss and original download; no crash                                                                        |
| A06 | Server considers a file unchanged, but local bytes are corrupt                            | Complete descriptor restores that file; no archive request                                                       |
| A07 | Missing/404/corrupt patch, base mismatch, or patch application failure                    | Download the same target's original; final verification succeeds                                                 |
| A08 | Patch is larger than the original transfer                                                | Select the original                                                                                              |
| A09 | Every file changes, with many small files                                                 | One tar.br request when eligible, no individual-file requests, and evidence for every final hash and performance |
| A10 | Termination during installation, followed by retry                                        | Preserve stable state, reuse verified completed files, and distrust partial files                                |
| A11 | Crash when starting a new OTA                                                             | Recover stable or builtin state; avoid selecting the crashed Bundle again                                        |
| A12 | Native app update or rebuild with the same version                                        | A stale index cannot authorize incorrect reuse                                                                   |
| A13 | Manifest/descriptor hash or set mismatch, or signature failure                            | Fail closed and preserve the running state                                                                       |
| A14 | Deleted or renamed asset                                                                  | Completed directory exactly matches the target manifest file set                                                 |
| A15 | Older catalog response or late completion of a concurrent install                         | Existing generation/selection guards prevent stale activation                                                    |
| A16 | Unversioned endpoint or artifact without a manifest                                       | Unsupported-protocol error; never reset or empty success                                                         |
| A17 | Disk exhaustion or index-write failure                                                    | Preserve stable state; downloading remains possible when only the index optimization fails                       |
| A18 | `getManifest()` called before initialization                                              | An empty session cache does not block first-OTA reuse                                                            |
| A19 | 0/1/2 remaining files, ties, framing boundary/excess, reuse/patch, missing sizes/overflow | Framing allowance applies only to complete-original downloads; all other cases use strict cost comparison        |
| A20 | Archive 404/corruption/truncation or TAR path/duplicate/link/set/size violation           | Discard scratch, run the individual-original fallback once, preserve stable state, and never cycle between paths |
| A21 | Valid tar.br and long PAX paths                                                           | Exact file set, sizes, hashes/signatures, and separately preserved manifest                                      |
| A22 | Deploy/copy and Storage cleanup                                                           | Signed archive metadata, uploads complete before publication, live archives retained and dead archives deleted   |

## 8. File boundaries

Modify only the directly related areas below. Add files only when directly needed, such as adjacent tests or small native resolvers.

- `packages/core/src/{types,bundleArtifacts}.ts` and contract tests.
- `packages/server/src/db/{updateArtifacts,releaseCatalog,createBundleDiff}.ts`, the HTTP artifact boundary, and affected schemas/migrations/adapters/tests.
- `packages/react-native/src/{native,httpClient,checkForUpdate,store}.ts`, native specs, and actual consumers.
- Storage, download, hashing, builtin resolution, archive-removal targets, and corresponding Test/Package.swift files in `packages/react-native/ios/HotUpdater/Internal/`.
- The same responsibilities, unit tests, and build dependencies in `packages/react-native/android/src/main/java/com/hotupdater/`.
- `packages/hot-updater/src/commands/deploy.ts`, necessary field changes in bundle/artifact/patch commands, config loading, `utils/bundleManifest.ts`, signing, and related tests.
- Bundle/DB/storage contracts in `plugins/plugin-core/src/` and directly affected provider schemas/CRUD/migrations.
- Only actual consumers of removed archive fields in `packages/console`; do not redesign its UI.
- `examples/v0.85.0`, `e2e/detox`, directly affected documentation/example configuration, and `.changeset`.
- The PRD, execution status, and verification evidence in `plans/`.

Follow `packages/server/AGENTS.md` for server public-entry boundaries. Use existing `cli-ui.ts` for CLI output. Removing configuration is not a reason to migrate unrelated deploy UI. Match existing naming/formatting and make only necessary changes.

## 9. Verification commands and environment

Run all commands from the working directory above unless noted otherwise. If worktree dependencies are absent, check the repository's Node/pnpm requirements and run `pnpm install --frozen-lockfile`. Do not arbitrarily create symlinks that modify the main checkout's node_modules or output directories.

| Purpose                  | Command                                                                                  | Success criterion                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Baseline check           | `git diff --stat ec78756926cac3b23ca32c1d3acefe28d2ebb7ab..HEAD -- packages plugins e2e` | Review differences between live code and this PRD when changes exist |
| Build                    | `pnpm -w build`                                                                          | Exit 0                                                               |
| Types                    | `pnpm -w test:type`                                                                      | Exit 0                                                               |
| Lint                     | `pnpm -w lint`                                                                           | Exit 0                                                               |
| Unit                     | `pnpm -w test`                                                                           | All pass                                                             |
| Integration              | `pnpm -w test:integration`                                                               | All pass; consult existing CI for Java requirements                  |
| Swift                    | `pnpm -w test:swift`                                                                     | Pass, including relevant native tests                                |
| Android                  | `./gradlew :hot-updater_react-native:testDebugUnitTest --build-cache`                    | Run in `examples/v0.85.0/android`; relevant tests pass               |
| E2E discovery            | `pnpm -w e2e:detox -- --list`                                                            | New scenarios and suites are listed                                  |
| E2E plan                 | `pnpm -w e2e:detox -- --platform all --suite default --dry-run`                          | Includes scenarios for both platforms                                |
| Prepared-environment E2E | `pnpm -w e2e:detox -- --platform all --suite default`                                    | Pass using the changed native artifacts                              |
| Change scope             | `git diff --check` and `git status --short`                                              | No whitespace errors or unrelated file changes                       |

Run focused tests for the failing scenario before expensive full verification. Do not repeat already-passed checks without changes. Simulator/unit results alone do not complete Release packaging verification for changed native code.

For dashboard/device E2E, read and use this checkout's `.agents/skills/hot-updater-agent/SKILL.md`. The default profile is `standalone-kysely`. Start by inspecting existing work with `hot-updater-agent status -limit 5`. `verify` requires a current PR and cannot provide success evidence for a local diff without one. Use a locally prepared harness or a manual environment for an exact ref supported by the CLI, and record the tested SHA. Do not assume remote jobs include local uncommitted changes. Always release manual leases. Never record private keys, credentials, or .env values in documentation or logs.

## 10. Completion conditions

- [x] M0 measurements document actual builtin-file mapping and reuse/fallback limitations on both platforms.
- [x] The first OTA reuses identical builtin files without mandatory build-time manifest injection.
- [x] The builtin index is asynchronous, partial, regenerable, and safe across native package identity changes.
- [x] Originals exist for every target file, allowing installation without a base/cache/patch.
- [x] Local corruption and patch failure recover per file.
- [x] Signing/hash/path/atomic-staging/catalog/recovery invariants are preserved.
- [x] The sole tar.br archive path, deterministic selection, and failure recovery are implemented without ZIP/gzip/automatic detection/strategy branches.
- [x] `compressStrategy` is removed from the public surface and old configuration is explicitly rejected.
- [x] The 1.0.0 schemas/migrations and versioned protocol are directly updated and tested.
- [x] Actual tar.br measurements compare bytes/requests/time/disk/memory for small and complete changes and resolve the many-file request bottleneck. The 80-run results and near-tie under a bandwidth cap are recorded in `evidence/native-tar-br-transfer.{md,json}`.
- [ ] The follow-up implementation revision passes unit/integration/native checks, required CI, and full E2E for all five standalone-\* profiles plus AWS, Firebase, Cloudflare, and Supabase using reconciled workspace runtimes. Earlier passing revisions remain historical evidence.
- [x] Documentation does not claim that the first builtin Hermes patch works without base registration.
- [x] Documentation, examples, changeset, execution status, and actual verification evidence reflect the tar.br agreement.

## 11. Conditions that constrain implementation

These are boundaries against arbitrary design changes, not automatic approval requests. Continue independent implementation and verification work.

- Do not reuse a format if doing so requires substituting semantic equality for byte equality.
- Do not pass the builtin-reuse gate unless the required benefit is demonstrated in a stock Release build. Report the actual difference and smallest alternative.
- Do not expand scope if the first Hermes patch would require mandatory CI upload or a new Release policy.
- If credential scope must expand, check existing authorization and remain within its bounds.
- When external device/build/signing environments are unavailable, continue feasible source/local tests, but do not mark actual Release verification complete.

## 12. Evidence and remaining judgments

- [Apple: Bundles are not modified at runtime](https://developer.apple.com/documentation/xcode/embedding-nonstandard-code-structures-in-a-bundle)
- [Android AAPT2: Resource compilation and PNG processing](https://developer.android.com/tools/aapt2)
- [Android App Bundle: Configuration APKs, including density splits](https://developer.android.com/guide/app-bundle/configure-base)
- `getAssetDestPathAndroid`, `getAssetDestPathIOS`, `saveAssets`, and `AssetSourceResolver` inspected in RN 0.85.2 show that actual installed paths may differ from bundler output paths.

M0 measurements are recorded in `plans/evidence/builtin-packaging.md` and JSON. All 17 OTA PNGs on iOS matched ordinary bundle-relative files. Only 5 of 17 PNGs matched in the installed Android arm64/en/xxhdpi split set. On both platforms, the current Re.Pack native build and bare OTA build produced different HBC bytes. Retain the partial index and per-file original fallback design.

Native package cache identity uses iOS app bundle identity and Android package/split identity. The artifact boundary supports only the versioned v1 endpoint. The initial v1 schemas and first migrations were directly changed to the archive-free database contract.

M3 measurements are recorded in `plans/evidence/manifest-transfer.md` and JSON. In the Android Release fixture, the first OTA decreased from 1,048,299 to 830,077 bytes, and an actual HBC patch OTA decreased from 1,048,348 to 115,353 bytes. A complete change across 1,000 files required 1,001 requests and local installation was 35.5% slower than ZIP, documenting the individual-file protocol's scalability limitation. Do not generalize these results into a performance improvement for every workload.

Full Release E2E passed for Prisma, Kysely, MongoDB, DynamoDB, and Drizzle at exact revision `0e821f7fa8f365a7446c2ab41fbe92ee852ddb4e`. Each profile ran iOS 15/15 + 11/11 and Android 26/26, including `fingerprint-initial-install` and `bspatch-builtin-to-diff-ota` on both platforms. Detailed job IDs and results are recorded in `plans/evidence/device-e2e.md`.

After the 2026-09-21 audit fixes, the actual Swift installer comparison is recorded in `plans/evidence/native-transfer.md` and JSON. Installation of 1,000 files improved 71.1% over sequential processing but took 9.3 times as long as ZIP, so M3 was not accepted then. Earlier Node microbenchmarks and E2E results from earlier revisions do not establish full acceptance of the current implementation.

On 2026-09-21, the user approved tar.br as the sole optional archive path. Section 5.7 and the adversarial agreement supersede the earlier decision to remove archives entirely. Preserve earlier measurements and E2E as evidence for those implementations, not as proof of the new tar.br implementation.

The 2026-09-21 tar.br follow-up implementation and latest native performance evidence are recorded in `evidence/native-tar-br-transfer.{md,json}`. They resolve the 1,000-file request bottleneck left by archive removal alone. Do not claim a speed improvement at 512 KiB/s; explicitly state the additional framing bytes and temporary disk cost.

On 2026-09-22, all five standalone full E2E profiles passed at final implementation `797338cd0a4daab9cac93383154a961820b9c563`, each with iOS 27/27 + Android 27/27. All GitHub checks passed at the same revision. `evidence/standalone-tar-br.{md,json}` preserves 270 scenario results, 10 builtin-reuse records, and 30 actual-transfer/full-file-hash records. The follow-up verification-documentation commit changes neither production code nor native fingerprints.
