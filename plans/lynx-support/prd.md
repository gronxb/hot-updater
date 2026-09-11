# PRD: Lynx runtime support

Date: 2026-09-11

**Status: approved for execution by the user on 2026-09-11. G1 in progress.**

This PRD defines the proposed scope of `@hot-updater/lynx` and
`examples/lynx`. Existing experimental code is unreviewed and does not determine
the public contract. The user has authorized execution of this PRD in the
`codex/lynx-support` worktree. Track implementation and evidence in the
[execution ledger](./execution.md).

Three subagents reviewed the proposal separately, exchanged objections, and
revised their positions. Their conditional agreement is a design recommendation,
not user approval or evidence of working native OTA. See the
[adversarial review record](./adversarial-review.md).

## 1. Product outcome

Hot Updater must deliver OTA updates to applications running on the **Lynx
engine**. ReactLynx, VueLynx, and OctaneLynx are equal support targets. Sparkling
is the proposed first native host, not the definition of Lynx support.

The application retains its UI framework and compiler. Hot Updater owns update
selection, artifact verification, installation, activation, and startup recovery.

For each framework and OS, the acceptance outcome is:

1. Install native release binary A once.
2. Download and install update B without replacing that native binary.
3. Restart the process offline and run B, including its packaged dependencies.
4. Confirm successful startup and retain B on subsequent starts.
5. Recover from a failed candidate to an eligible confirmed release or the
   compatible embedded release.

All six framework × iOS/Android combinations must pass. Native host integration
source and scenarios are shared; different combinations may require different
compatible native runtime versions. “Same binary” applies within each scenario.
Arbitrary cross-framework replacement in one binary is not an initial acceptance
requirement.

## 2. Responsibilities and initial scope

| Layer | Responsibility |
| --- | --- |
| ReactLynx / VueLynx / OctaneLynx | UI, application lifecycle, framework compilation and thread transitions |
| Application build integration | Run its compiler or provide compatible prebuilt native files; identify the entry and managed dependencies |
| `@hot-updater/lynx` | Framework-independent JS runtime API, Node build integration, and the Lynx/native module boundary |
| Native update integration | Verify and install files, select a release, bind resources and startup state, and recover safely |
| Sparkling or another host | Connect actual resource loaders, module registration, container identity, and startup observations |
| Existing Hot Updater delivery infrastructure | Release/catalog selection, deployment policy, storage, manifests and configured signing |

The initial OTA proposal uses full archives, APP_VERSION server targeting, and
activation on the next **application process start**. The process selects one
release; every Lynx container in that process remains pinned to it. One
host-designated primary context participates in startup confirmation.

Automatic fingerprint generation, delta patches, live reload, independent
per-container updates, arbitrary multi-entry deployment policies, insights, and
init/doctor integration are follow-up scope. Runtime compatibility validation is
required initially even though automatic fingerprint generation is deferred.

RN and Lynx use separate delivery projects initially, including catalog/database
state and storage configuration. Channels alone do not provide engine isolation.
This operational separation does not replace native compatibility checks.

## 3. Evidence and constraints

### Upstream evidence

- [Sparkling's build command](https://github.com/tiktok/sparkling/blob/c4ce8d25c5ea277e13752d68ff1f2a66f5704240/packages/sparkling-app-cli/src/commands/build.ts)
  separates compilation from copying files into native application assets.
- Sparkling's
  [Android template provider](https://github.com/tiktok/sparkling/blob/c4ce8d25c5ea277e13752d68ff1f2a66f5704240/template/sparkling-app-template/android/app/src/main/java/com/example/sparkling/go/BuiltinTemplateProvider.kt)
  and [iOS resource loader](https://github.com/tiktok/sparkling/blob/c4ce8d25c5ea277e13752d68ff1f2a66f5704240/packages/sparkling-sdk/ios/Sparkling/Sources/Application/Container/Resource/SPKResourceLoaderImpl.swift)
  do not establish Hot Updater installation-root selection and recovery.
  Template, image, external JavaScript, and dynamic-component loading require
  separate verification; changing only the main template path is insufficient.
- [Lynx Native Modules](https://lynxjs.org/guide/use-native-modules.html) are
  available from background scripting. A framework-independent dependency list
  does not prove that SDK imports and calls are valid in both execution graphs.
- [VueLynx's example configuration](https://github.com/Huxpro/vue-lynx/blob/4e75e3ef1efc17a239adaa48a665ef699a6423f5/examples/hello-world/lynx.config.ts)
  has separate native/web environments and a configured asset URL prefix.
- [Octane's Lynx documentation](https://octanejs.dev/docs/lynx) describes a
  source-based toolchain and incomplete native module/device verification.
  Its [gallery configuration](https://github.com/octanejs/octane/blob/c31f629185f7d768c821557f6fb49dc46daf671c/packages/rspeedy-plugin-octane/examples/gallery/lynx.config.mjs)
  delegates asset-prefix selection to the publisher. Copying its output tree does
  not prove that resource URLs resolve relative to the installed bundle.
- The inspected Octane toolchain uses Rspeedy 0.16.0 / Rsbuild 2.1.4; the earlier
  React experiment used Rspeedy 0.13.x. A fixed compiler version, React plugin,
  object-only configuration, or single build environment cannot be the shared
  integration contract.

These are source and documentation findings, not device test results. Pin and
record resolved native dependencies during feasibility work; template version
declarations alone are insufficient.

### Existing repository constraints

- `plugins/plugin-core/src/types/index.ts:92-113` exposes a reusable
  `BuildPlugin` returning a directory and bundle ID without a UI framework type.
- `packages/hot-updater/src/utils/getBundleZipTargets.ts:27-60` removes `.map`
  files and renames or replaces `.bundle.hbc` candidates. Those RN/Hermes rules
  conflict with preserving opaque Lynx file names and bytes.
- `packages/hot-updater/src/commands/deploy.ts:968-1005` hashes the input tree
  before writing its own `manifest.json`. A compiler-produced root manifest
  would be overwritten and included twice in archive targets.
- `packages/core/src/releaseCatalogScope.ts:173-197` and
  `plugins/plugin-core/src/releaseCatalogCompiler.ts:727-737` provide OS/channel
  scope and semver targeting, not a Lynx/PrimJS/native-module ABI check.
- Existing RN native entry discovery assumes specific bundle names or one bundle
  candidate. Its runtime hooks and readiness reporting are RN-specific. Reuse
  policy and verification logic selectively; do not assume the native engine
  can be reused by changing an entry filename.

## 4. Adversarial review decisions

The following recommendations incorporate both rounds of review and the targeted
retry-policy rebuttal. Open implementation details remain in section 8.

| ID | Challenged assumption | Proposed resolution |
| --- | --- | --- |
| D1 | A generic BuildPlugin makes the entire existing archive path generic | Reuse BuildPlugin integration; keep RN renaming/filtering out of Lynx handling and native entry discovery. Determine an explicit artifact-handling boundary before freezing the interface. Reject metadata collisions and inspect the actual CLI archive. |
| D2 | Separate backend + OS/appVersion guarantees native compatibility | Native owns an immutable compatibility identity and requires an exact match with verified artifact metadata before execution. Server targeting is a separate constraint. |
| D3 | Preserving a file tree guarantees offline prebuilt support | Require a proven host resource-addressing contract, release-aware caches and lifetime, and no fallback to another release for managed dependencies. |
| D4 | Plain JS APIs can call native from any framework execution graph | Imports have no native-call side effects. Native calls originate from background JS; native binds readiness to the actual attempt and primary context. |
| D5 | Missing readiness is equivalent to a crash, or one retry receipt suffices | Distinguish confirmed startup failures from unexplained exits. Preserve per-Release exclusions across subsequent attempts; a newer failed candidate must not make an older excluded candidate eligible again. |
| D6 | Stabilize the package API before proving native loading and bridge behavior | Run native feasibility across all six combinations first. Internal adapters and manual local placement are allowed in that future spike; they do not count as OTA completion. |
| D7 | Equal framework support requires one binary for all frameworks | Share the host integration and scenarios. Keep each scenario's native binary unchanged across A/B; record compatibility separately for each combination. |
| D8 | Compiler output identity, bundle identity and Release identity are interchangeable | Native owns embedded/minimum IDs. Packaging assigns the OTA bundle ID. Catalog Release IDs identify authorization and remain separate from bytes and startup attempts. |

## 5. Required behavior

### 5.1 Framework and compiler independence

- Runtime and build entrypoints must have no required React, Vue, or Octane
  dependency, peer dependency, hook, wrapper, or framework compiler plugin.
- Keep the Node build entrypoint separate from the runtime entrypoint. Runtime
  imports must be safe in the supported main/background graphs and must not
  access native modules or register native listeners during module evaluation.
- The application owns compilation, including native/web environment selection
  and moving framework callbacks to the background environment when necessary.
- Three real toolchains must use the same integration contract. Renamed mocks
  do not establish framework compatibility. Use pinned upstream source for
  unpublished Octane tooling; do not substitute fake packages or shims.

### 5.2 Artifact and identity contract

- Accept compiler output or prebuilt native files that satisfy the declared
  native compatibility, resource-addressing, and readiness contracts.
- A build integration receives the OS, packaging bundle ID, working directory,
  and an empty output directory. It identifies a main entry and supplies the
  artifact's declared native compatibility identity. Exact API names are not
  fixed by this PRD.
- Preserve the selected files' bytes, relative names, and dependency paths.
  Do not rewrite bundle contents, infer a framework from an extension, or require
  exactly one `.bundle` file. CLI artifact handling must be explicit rather than
  inferred from a UI framework name or file extension.
- The build integration excludes web output, development-only files, source
  maps, and stale output deliberately. Archive construction must not delete a
  runtime dependency solely because its extension resembles an RN convention.
- Reject traversal, symbolic links, missing or empty entries, and collisions
  with root `manifest.json` or the selected Hot Updater metadata path. Do not
  silently overwrite earlier Hot Updater metadata when accepting prebuilt input.
- Versioned entry metadata must bind the bundle ID, OS, main entry and native
  compatibility identity. A manifest-covered sidecar is the proposed transport;
  its filename and final serialization are G1 outputs. Unsupported schema
  versions are rejected.
- Generate the OTA bundle ID when packaging, without requiring compiler define
  injection. Compiler build identifiers and catalog Release IDs are distinct.
  Native supplies its embedded bundle identity and minimum accepted bundle ID;
  these must not come from downloaded JavaScript.
- Packaging creates a new Bundle. Promotion or rollback can authorize an
  existing Bundle through a Release and must not repackage it automatically.

### 5.3 Verification and native compatibility

Before evaluating any candidate template, main-thread script, or background
script, native must complete the existing archive/manifest integrity checks and
configured signature checks, safely extract files, verify entry metadata, and
match the selected bundle ID, OS and native compatibility identity. The entry
must be confined to the installation and included in the verified manifest.
Missing or mismatched fields fail closed and leave the current release intact.
When native signing is configured, unsigned input must remain unacceptable.

Each native binary embeds its expected compatibility identity. The identity
represents the declared engine/PrimJS, loader/bridge, and application native-module
contract. It is not a UI framework name. Exact equality is the initial proposal;
unknown compatibility is rejected. A manually maintained identity is acceptable
initially if embedded by the native build and supplied by release tooling.

Identity equality enforces that declared contract; it does not automatically
discover ABI changes that a producer failed to declare. G1 must document the
identity's native source, artifact provenance, invalidating inputs, and ownership.
Pinned toolchain/host device evidence is still required when identities match.
APP_VERSION remains server targeting, and fingerprint automation may follow later.

No server schema migration is assumed for the initial identity check; verify
that assumption during integration. A server-selected candidate may still be
rejected locally. In the initial policy, a compatibility mismatch terminates that
check with a specific incompatibility result and unchanged launch state. It must
not silently mutate the accepted catalog, become a crash-history entry, or imply
that an older compatible candidate was selected automatically. Repeated checks
must avoid downloading the same known-incompatible artifact indefinitely; G1
must define rejection caching and invalidation against native/artifact identity.

### 5.4 Resource resolution and lifetime

All release-owned entry, JavaScript, dynamic components, lazy chunks, images and
fonts must resolve deterministically inside the selected release through
host-supported mappings. The mapping need not use bundle-relative URLs, but it
must be proven for each relevant loader and cache.

Managed dependency misses must fail that release instead of silently reading
embedded A, a different installed release, or a network copy. Ordinary remote
application data remains outside this packaged-dependency guarantee. Unsupported
prebuilt addressing must produce a diagnostic; it cannot be repaired by silently
rewriting opaque bundle bytes.

Installing B must not change the active process's selected release or overwrite
its files. Secondary containers use the same pinned release as the primary
context. Resource caches distinguish release identity, and cleanup retains
directories referenced by live contexts or in-flight resource requests.

### 5.5 Startup confirmation and recovery

Record a durable startup attempt immediately before evaluating a candidate in
the host-designated primary Lynx context. Download completion or native process
creation alone does not start an attempt. A process that never opens that context
must not count as a failed Lynx startup.

The host designates the primary context before any candidate execution. No
context may evaluate candidate code before that startup attempt is durably
recorded. A secondary context requested earlier must wait, fail to open, or be
explicitly designated as the primary before evaluation; it must not execute an
untracked candidate or silently select a different release.

Confirmation requires both native evidence of initial content in the designated
context and an app/host signal that essential startup, including required
background bootstrap, succeeded. G1 must prove the concrete callbacks on each
host/runtime combination. A fixed delay, module import, load-finished event,
runtime creation or first screen alone is insufficient.

Native accepts the signal only for the current pending attempt, from its live
designated context or a trusted host authority, without an invalidating startup
failure. Repeated valid signals are idempotent. Stale, destroyed-context, or
unrelated-context signals cannot confirm another attempt. JS-supplied IDs alone
do not establish authority.

SDK-free prebuilt files may be packaged, but confirmed OTA operation also requires
an application signal or a host that proves the same startup conditions. Merely
installing such files is not evidence of full support.

| Event | Durable outcome | Next process behavior |
| --- | --- | --- |
| Installed but not evaluated | Installed candidate; no startup attempt | Candidate may be evaluated normally |
| Primary candidate evaluation starts | Pending attempt bound to release and native binary | Await confirmation or classify its outcome |
| Valid native observation and ready signal | Confirmed release | Retain it while eligible and compatible |
| Verified fatal template/JS/native startup failure | Failed attempt and existing crash-history semantics | Recover to an eligible confirmed release or compatible embedded release |
| Pending attempt found without confirmation or recorded fatal failure | Unconfirmed termination, separate from crash history | Recover and suppress automatic restaging of that Release ID |
| Error after confirmation | Outside the initial startup rollback guarantee | Do not promise rollback of arbitrary later application errors |

An unexplained exit may be a healthy application closed early by the user. The
proposed conservative policy still falls back and holds that Release ID. A new
published and authorized Release ID can permit another attempt, even with cached
identical bytes; it must create a fresh attempt and cannot inherit prior ready
state. No separate manual-retry API is required initially.

Unconfirmed exclusions persist across later attempts within the same native
binary/scope. Every automatic candidate and rollback path must honor them.
Changes to exclusions invalidate stale selection context and prepared install
authorization. Unrelated catalog generations and ordinary restarts cannot clear
them. Compaction or eviction must not make a still-selectable excluded release
eligible again. Storage representation and safe capacity handling are G1 decisions.

Cached files may be reused without downloading again. An unconfirmed retry must
not take a metadata-only adoption path that assumes verified running bytes.
Normal adoption of already confirmed, currently running bytes retains its
existing semantics.

Preserve existing catalog freshness, authorization, stable-selection, crash
history and rollback guarantees. Unconfirmed-exit suppression is an explicit
Lynx requirement to design and verify; the existing crashed-bundle selector alone
does not implement it.

## 6. Proposed milestones and gates

### G0 — Review this PRD (completed)

Review the support targets, responsibility boundaries, compatibility invariant,
process-wide activation, conservative startup policy, and milestone order.
The user explicitly approved execution after the adversarial review. G0 is
complete through that authorization; subagent agreement alone did not complete it.

### G1 — Native feasibility and contract decisions

After G0 review, use pinned Sparkling hosts and all three production toolchains.
Internal build adapters and manual local placement of B are valid spike tools;
the full OTA engine is not a prerequisite for this stage.

Required evidence across all six combinations:

- Actual native binary identity and resolved Lynx/PrimJS/module versions.
- Embedded A and manually placed B decode and run offline with all managed
  resource categories used by the fixtures; same-name A/B assets cannot mix.
- Safe SDK imports across execution graphs, background module calls, async
  success/error transport, and correctly attributed readiness.
- A supported resource URL/cache contract, native-owned compatibility identity,
  and versioned entry metadata design. Demonstrate mismatch rejection before
  candidate execution.
- Startup failure classification and the decision table above, including late
  ready signals, a process that never opens the primary context, and B/C
  unconfirmed attempts that must not re-enable B.
- A bounded storage/retention design that preserves exclusion semantics and
  invalidates stale authorization; define compatibility-rejection caching too.

G1 produces a native reuse decision, concrete loader/module integration points,
metadata schema, compatibility inputs, and public API proposal. Freeze no public
Lynx API until this feasibility evidence exists. Upstream failure remains an
uncompleted target; changing framework scope requires separate user review.

### G2 — Package, build/deploy integration, and examples

Implement `@hot-updater/lynx` and `examples/lynx` against the G1 contracts.

- Separate runtime and build exports without mandatory framework dependencies.
- Provide reproducible ReactLynx, VueLynx and pinned-source OctaneLynx entrypoints,
  shared host integration, and documented native prerequisites.
- Use real framework output through the existing CLI deployment/archive path;
  inspect the final archive and manifest, not just the BuildPlugin return value.
- Preserve names and hashes, bind metadata correctly, reject reserved-file
  collisions and invalid paths, and preserve previous successful output after a
  compiler failure.
- Verify native entry selection with multiple managed bundles and test the RN
  integration boundary where shared code changes. Do not widen native refactors
  beyond demonstrated reuse needs.

G2 is integration evidence, not completion of production OTA support.

### G3 — OTA installation and recovery

Implement download, verification, safe staging, atomic installation/selection,
process restart activation, confirmation and recovery. Complete the acceptance
matrix in section 7 on unchanged release binaries, without a development server.

### G4 — Subsequent proposals

Use G3 evidence to propose fingerprint automation, delta patches, live reload,
insights, CLI onboarding and richer multi-entry/container policies separately.

## 7. Acceptance evidence

Each run records the native binary identity, resolved runtime and compiler
versions, A/B bundle and Release IDs, entry/resource hashes, resource-loader
observations, and native activation/recovery logs. Web preview, compilation and
archive inspection do not prove device OTA.

| Scenario | Required result |
| --- | --- |
| Embedded A → installed B → offline process restart | B entry and all managed dependencies load from B |
| Valid B confirmation → another restart | B remains confirmed |
| Fatal startup error / unexplained pre-ready termination | Distinct history and exclusion outcomes; eligible confirmed or embedded fallback |
| B exits unconfirmed, then C exits unconfirmed | Later selection cannot silently re-enable B |
| New authorized Release ID references previously unconfirmed cached bytes | Fresh attempt; no inherited readiness or cached-install/adoption bypass |
| Exclusion changes after an install was prepared | Stale selection authorization cannot install the excluded candidate |
| Primary context never opens / stale or secondary ready arrives | No invented failed attempt; no unauthorized confirmation |
| Secondary context requests candidate execution before primary startup | Defer/reject opening or explicitly designate it primary; no candidate execution before the durable attempt |
| Corrupt archive/hash, configured signature failure, traversal or metadata mismatch | Reject before candidate execution; preserve the current release |
| Same appVersion but different native compatibility identity | Reject before execution with an incompatibility result; avoid repeated download loops |
| Interrupted installation or concurrent requests | No partial installation becomes active |
| Multiple containers and in-flight resource requests | One process release; no mixed resources or premature cleanup |
| Native binary upgrade | Revalidate compatibility and binary-scoped state; use a safe fallback |
| Native files resemble RN names or collide with reserved metadata | Preserve supported runtime files; reject metadata conflicts before upload |

| Framework | iOS: native startup, bridge, OTA, recovery | Android: native startup, bridge, OTA, recovery |
| --- | --- | --- |
| ReactLynx | Unverified | Unverified |
| VueLynx | Unverified | Unverified |
| OctaneLynx | Unverified | Unverified |

All six cells must pass before claiming the proposed support is complete.

## 8. Decisions that require G1 evidence

| Decision | Fixed requirement | Detail still to determine |
| --- | --- | --- |
| Host | Sparkling is the first candidate; all targets remain | Resolved versions and supported loader/module hooks on each OS |
| Compatibility | Native-owned, exact, fail-closed declared identity | Identity derivation/provenance, invalidating inputs and rejection-cache invalidation |
| Metadata | Versioned, manifest-bound, conflict-free | Filename, concrete fields and native parser boundary |
| Resource addressing | Release-bound resolution, cache and lifetime | Supported schemes/prefixes and per-resource loader mapping |
| Startup confirmation | Native observation plus attributed app/host readiness | Concrete callbacks and essential background-bootstrap observation |
| Unconfirmed exits | Conservative fallback and durable per-Release suppression | Storage/compaction/capacity handling without re-enabling exclusions |
| Native reuse | Preserve relevant policy/security guarantees | Selective reuse versus small Lynx-specific implementations |
| CLI integration | Actual final artifact must satisfy the contract | Minimum explicit artifact-handling changes, native configuration discovery and signing |

## 9. Current work and limitations

- Package/example code was added prematurely after the first draft. It was
  paused for PRD review and remains unvalidated; the changeset is not a release
  approval. The approved execution now begins with G1.
- Earlier React-focused experiments built and passed repository tests. The
  contract subsequently changed, so those results do not validate the current
  experimental implementation or this revised PRD.
- During earlier research, the pinned Octane gallery produced a native bundle
  and image assets. It has not been installed through Hot Updater or verified
  in the native acceptance matrix.
- The Vue example and revised common-contract implementation stopped before
  validation. All native OTA combinations remain unverified.
- The adversarial review changed planning documents only. Subsequent authorized
  implementation and verification are tracked in the execution ledger.
