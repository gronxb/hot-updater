# PRD: Lynx runtime support

Created: 2026-09-11. Decisions consolidated: 2026-09-21.

**Status: approved for execution on 2026-09-11; implementation and acceptance
reconciliation resumed on 2026-09-13; default page navigation was amended on
2026-09-14.** See the current
[handoff and completion plan](./handoff.md) for the implementation checkpoint and
remaining verification. This PRD's acceptance requirements remain in force.

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

The basic Sparkling application structure is page based. The default example
and acceptance fixtures compile `main.lynx.bundle` and
`detail.lynx.bundle` as independent page entries, and application navigation
uses the public `sparkling-navigation` API to open the detail page in a new
native container. A single main bundle or an application-local simulated page
stack does not satisfy the default example or acceptance contract.

The application retains its UI framework and compiler. Hot Updater owns update
selection, artifact verification, installation, activation, and startup recovery.

For each framework and OS, the acceptance outcome is:

1. Install native release binary A once, run its main page, and open its detail
   page through `sparkling-navigation`.
2. Download and install update B without replacing that native binary.
3. Restart the process offline and run both B pages and their packaged
   dependencies from the same verified Release.
4. Confirm successful startup and retain B on subsequent starts.
5. Apply the forward C update and reverse rollback chain while keeping every
   live page on one selected Release and managed generation.
6. Recover from a failed candidate to an eligible confirmed release or the
   compatible embedded release.

All six framework × iOS/Android combinations must pass. Native host integration
source and scenarios are shared; different combinations may require different
compatible native runtime versions. “Same binary” applies within each scenario.
Arbitrary cross-framework replacement in one binary is not an initial acceptance
requirement.

## 2. Responsibilities and initial scope

| Layer                                        | Responsibility                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ReactLynx / VueLynx / OctaneLynx             | UI, application lifecycle, framework compilation and thread transitions                                                                             |
| Application build integration                | Run its compiler or provide compatible prebuilt native files; identify the main entry, deterministic page-entry allowlist, and managed dependencies |
| `@hot-updater/lynx`                          | Framework-independent JS runtime API, Node build integration, and the Lynx/native module boundary                                                   |
| Native update integration                    | Verify and install files, select a release, bind resources and startup state, and recover safely                                                    |
| Packaged Sparkling integration               | Connect actual resource loaders, module and router registration, the native page stack, container identity, and startup observations                |
| Existing Hot Updater delivery infrastructure | Release/catalog selection, deployment policy, storage, manifests and configured signing                                                             |

The OTA scope includes full archives and verified delta updates, app-version and
native fingerprint targeting, next-launch activation, and explicit immediate
activation through `HotUpdater.reload()`. On 2026-09-13 the user approved
recreating the entire library-managed Lynx runtime on both iOS and Android.
Each managed runtime generation selects one release; every container in that
generation remains pinned to it. One host-designated primary context participates
in startup confirmation. Section 5.6 replaces the earlier process-wide invariant
for this explicit generation transition.

The user added delta updates to the required scope on 2026-09-13 and explicitly
excluded migration from the legacy React Native metadata format. Delta includes
manifest-driven asset replacement, BSDIFF application, consecutive updates,
rollback patch bases, and verified fallback to complete files or a full archive.
The shared E2E scenarios must exercise those actual behaviors. An archive download
must not be reported as a successful delta application.

Page-based multi-entry packaging and managed Sparkling navigation are required
initial scope. Every page in one artifact is deployed, selected, installed,
activated, governed by one startup confirmation/recovery policy, rolled back,
and retained as part of one complete Release; there is no independent per-page
deployment, selection, version, or rollback.
Arbitrary per-page delivery policies and new analytics telemetry remain
follow-up scope. Runtime compatibility validation remains required. Lynx-only
init and doctor operation through integration-owned hooks is part of the
pure-core release gate. Existing fingerprint targeting must use a meaningful
integration-owned native fingerprint when enabled.

RN and Lynx use separate delivery projects initially. One deployed process,
provider account, and physical database service may host both, but each project
must use a distinct `createHotUpdater` instance, base route, database or schema,
API-key authority, and storage namespace. Channels, app versions, fingerprints,
signing keys, and native `runtimeId` do not provide delivery-project isolation.
Consequently this PR does not add an `RN | Lynx` database discriminator or a new
migration. A future requirement to share one logical database namespace requires
a generic `deliveryProjectId` across authorization, routes, catalog scopes,
bundles, releases, patches, events, insights, and storage ownership. An engine or
framework enum is not an acceptable substitute. This operational separation does
not replace native compatibility checks.

### 2.1 Application integration requirements (2026-09-13 amendment)

An application generated by the official
[Sparkling scaffolder](https://tiktok.github.io/sparkling/guide/get-started/create-new-app)
must integrate Hot Updater through ordinary library dependencies, configuration,
registration, and selection of a library-managed host or bundle URL. It must not
implement custom native loaders, lifecycle delegates, crash classification,
restart workarounds, router/container implementations, or update-controller
logic in its iOS or Android application sources. Those behaviors belong to the
packaged library integration. The production application may contain only the
ordinary package registration, native identity/configuration, and host or page
stack mount wiring expected by a Sparkling application.

The engine contract remains independent of Sparkling. Sparkling is an optional
host integration for applications that choose that host, but that packaged
integration owns the managed router, native page stack, and containers required
by the default Sparkling structure. It must preserve real Sparkling bridge
initialization and supported lifecycle behavior. A URL accessor alone is not
proof of navigation, resource, or readiness integration.
Do not patch upstream source, use reflection, or simulate callbacks in the example
to manufacture missing host capabilities. Document the supported host/version and
verify the normal scaffold integration separately from private native probes.
Any controls needed to prove multiple containers, stale authorities, fatal
secondaries, or generation teardown must live in a separate nonproduction target
or scheme. The production application target must not compile those diagnostics.

The production scaffold receives its update endpoint from the native build
setting `HOT_UPDATER_APP_BASE_URL`. A configured value must be an absolute HTTPS
URL for a nonlocal host. iOS reads that setting through the application plist and
Android embeds it through the application build configuration; both deliver it
to JavaScript as `getLaunchConfiguration().appBaseURL`. The endpoint must not be
compiled into any Lynx bundle. When the setting is absent, the embedded release
still completes normal resource and application readiness, while the page shows
that the production update endpoint requires configuration. OTA checks remain
unavailable until a valid native setting is supplied.

Launch configuration precedence is host configuration, then nonproduction
diagnostics intent, then authorized managed-page parameters. Later sources may
replace an earlier value only after their own boundary has authorized it. The
diagnostics intent source requires an explicit nonproduction host opt-in. The
default host configuration, including the production target, does not read or
merge launch configuration from an intent.

### 2.2 Engine-neutral delivery requirements (2026-09-13 amendment)

The Hot Updater core is a pure runtime- and framework-neutral OTA engine. This
boundary includes `@hot-updater/core`, `@hot-updater/server`,
`@hot-updater/plugin-core`, the common `hot-updater` command layer, and generic
configuration/scaffolding utilities. These packages may express opaque platforms,
artifacts, catalogs, policies, signatures, storage, and integration hooks. They
must not contain React Native, Hermes, Metro, Expo, Lynx, Sparkling, `.hbc`, or
framework-specific artifact-selection and native-remediation policy.

An integration descriptor owns setup, dependencies, build output declarations,
fingerprinting, signing-key resolution, doctor checks, conflict detection, and
native remediation. React Native and Hermes behavior belongs to
`@hot-updater/react-native` and its Bare/Rock adapters. Expo behavior, including
Expo dependency discovery and `@expo/fingerprint`, belongs to the Expo adapter.
Lynx and optional Sparkling behavior belongs to `@hot-updater/lynx`. The common
CLI invokes integration hooks and never enumerates a closed set of RN build types.
The descriptor boundary must preserve the existing RN user flow while allowing a
Lynx-only project with no RN or Expo dependency to initialize, diagnose,
fingerprint, sign, deploy, and verify infrastructure.

A dependency-boundary test must fail when production code in the neutral packages
imports or embeds RN, Expo, Hermes, Metro, `.hbc`, `getJSBundleFile`,
`HotUpdater.bundleURL()`, `AppDelegate`, or `MainApplication` policy. RN and Expo
fixtures and checks remain in their integration packages. Package descriptions
and public docs for neutral packages must also describe runtime-neutral OTA.

Build integrations explicitly describe selected artifact paths, final names,
patch entry, download compression, and native fingerprint production. Common
packaging and delivery code consumes those declarations without inferring an
engine from filenames or invoking an unrelated framework's fingerprint engine.
Lynx fingerprints must change when relevant native inputs change; an empty-input
hash is not a valid implementation. Preserve existing RN behavior through its
integration and regression tests, including an explicit compatibility strategy
for artifacts produced before these declarations existed.

For new artifacts, the signed manifest carries an explicit `patchAssetPath` and
each asset's `downloadCompression` (`"br"` or `null` for raw bytes). Build output
declares source path, final relative name, and selected compression. The patch
entry must be covered by the manifest. Neither patch selection nor compression
may be inferred from `.bundle`, `.hbc`, or `index.*` names.

Older RN publications remain installable through their verified complete archive.
When an older manifest does not identify its stored compression unambiguously,
prefer archive delivery; preserving its former optimized delta path is not a
reason to retain RN filename rules in common code. Existing explicit patch
metadata may be consumed only when the storage path, base identity, and manifest
hashes establish the exact asset without guessing. Verify this compatibility
behavior with RN regression fixtures.

All database providers enforce one delivery contract: a target Bundle has at
most 24 ordered base patches, and replacing those patch rows is atomic. Bundle
deletion fails with the common referenced-row result while a Release or another
Bundle's patch still refers to it. Provider-native transactions and constraint
errors must preserve these results without partial patch publication or deletion.

The engine-neutral `ArtifactInfo` JSON response is limited to 528,384 UTF-8
bytes. The artifact endpoint resolves changed-file URLs in batches of at most 16
concurrent operations and preserves manifest order. It returns a valid bounded
manifest representation when usable, falls back to the verified archive when
manifest resolution or the response budget prevents that representation, and
returns no artifact when neither delivery is usable. An unavailable archive does
not prevent a valid bounded manifest-only response.

Optional patch rows must not make an otherwise valid archive unavailable. The
artifact endpoint may retry Bundle lookup without optional patch hydration when
strict hydration encounters a corrupt patch row, then use the archive or a valid
manifest without that patch. Administrative Bundle reads and lists remain strict
so corruption is visible to operators rather than silently normalized.

Deployment and promotion rollback must never delete shared content-addressed
assets. Replacing a patch row also does not prove that its former storage object
is unreferenced, so superseded patch objects remain stored. Any future cleanup
requires an ownership/reference model whose decision and deletion are proven
atomically across all possible references.

No formal release containing this server contract has shipped. Provider schema
changes therefore remain part of the initial 1.0.0 schema. In particular,
Supabase atomic Bundle-patch publication belongs in the existing 1.0.0 migration;
do not introduce a 1.0.1 migration, doctor requirement, or infrastructure-upgrade
document for this work.

An update check may authorize a catalog selection and ask native code to validate
its compatibility, but it must not retain downloaded bytes or an outstanding
native preparation merely because the caller received an update object. Native
preparation begins only when the caller requests installation and is consumed by
that same atomic stage operation.

An explicit channel change is an authorized catalog-scope transition. Native
must persist catalog acceptance and the selected channel under one revision, and
must reject an unrelated second switch until an explicit reset returns to the
configured default scope. Reset must clear the switched scope's accepted,
staged, pending, and stable state atomically.

### 2.3 Execution requirements

All PRD text and decision records remain in English. PRD drafting and decision
consolidation preceded implementation. The latest execution instruction supersedes
the earlier model-selection instructions. The user subsequently requested bounded
read-only subagents for a final adversarial architecture and data review; that
review was completed on 2026-09-21. Implementation remains in the primary task.
Model selection is an execution preference and does not change the product or
acceptance contract.

The execution worktree is `/Volumes/SSD_2TB/workspace/hot-updater-lynx`, branch
`codex/lynx-support`, PR #1300. Preserve the source checkout and the six staged-only
local helper files listed in the handoff. The goal is implementation and verified
acceptance, with an accurate reviewable PR. Merging and npm release publication
are outside this task.

### 2.4 Adversarial consensus (2026-09-21)

Three independent reviewers examined the Lynx architecture, the neutral package
boundary, and shared RN/Lynx infrastructure. They reached the following
consensus, which is binding on this PR's release claim:

1. The native generation, verified-resource, page-per-bundle, and one-Release
   page-stack model is sound, subject to the required device evidence.
2. No engine or framework database column is needed for the initial topology.
   RN and Lynx may share one deployment only through the isolated delivery-project
   instances defined above. Pointing both at one current table set, catalog route,
   or storage prefix is unsafe because catalog and delta-base identity contains no
   project axis.
3. The review found RN/Expo/Hermes setup, doctor, conflict, fingerprint, and
   native-remediation assumptions in the common CLI and generic configuration
   utilities. Commits `0c76a3d71` and `a18776c50` resolved that finding through
   discoverable integration descriptors and integration-owned command and doctor
   hooks. A source and package-description boundary test now rejects those
   policies in neutral production packages. Release acceptance still requires
   the Lynx-only command fixture and current device evidence.
4. Production Sparkling app sources may register, configure, mount, reattach, and
   close the packaged host. They may not select updates, resolve artifact paths,
   implement loaders or routers, classify crashes, restart the process, or import
   diagnostics. A structural source test enforces this distinction; diagnostic
   controls remain in nonproduction targets.
5. Equal ReactLynx, VueLynx, and OctaneLynx support is not established by the
   ReactLynx default suite or historical receipts. Current six-cell evidence is
   required. Framework-generated VueLynx and OctaneLynx `loadLazyBundle` output
   is a release blocker whenever it appears in supported production compiler
   output; core external JavaScript and native dynamic-component probes cannot be
   relabeled as that evidence.

The detailed attack paths and source anchors are recorded in the
[adversarial review](./adversarial-review.md). No source inspection result is a
substitute for the acceptance runs in section 7.

## 3. Evidence and constraints

### Upstream evidence

Sparkling provenance is independently pinned; a shared version label does not
prove shared source content:

- The currently built iOS Sparkling SDK and Router source is pinned to commit
  `c4ce8d25c5ea277e13752d68ff1f2a66f5704240`. Receipts record the checkout,
  source hashes, pod resolution and build inputs. This PRD does not claim that a
  published pod or any JavaScript/Android artifact has identical content.
- JavaScript uses the npm tarball `sparkling-navigation@2.1.0-rc.12`, locked by
  package-manager integrity
  `sha512-kAQ5jZsjAixrQuoCBiiojY4jNxyilrhP/ZAjg9DvCmqdOQME73rC1+BR8zax1cyxLeAaa0fxcztAS6exA78qnA==`
  and shasum `933e8f64558d38008b04576a4c6611ebddb21238`. Git tag
  `2.1.0-rc.12` resolves to
  `bb066d6b45189fa123b8494d789429605ca1337e`. The tarball and that tag's
  `navigate.ts` currently share SHA-256
  `a5e2dd1926904acddffde4e6d5c673a4ed49a5bf1b9d3050f6b77b2ffc6a3305`;
  build validation and route conformance tests verify the installed tarball
  rather than trusting the tag or version string alone.
- Android Sparkling core and Sparkling Method resolve Maven version
  `2.1.0-rc.12`; receipts record the repositories, resolved POM/AAR checksums and
  dependency graph. No equivalence to either source commit is assumed. The
  Android navigation native project is reproducibly sourced from the locked npm
  tarball/tag above only after its packaged files and autolink/local-project
  resolution are verified and recorded.

The npm tarball ships the Android navigation project as source and its
`android/build.gradle.kts` does not declare a Maven publication. An invented
Maven coordinate or unrecorded application copy is invalid. Failure to resolve
the locked source reproducibly blocks Android acceptance and does not justify an
application-owned router workaround. The exact independently pinned combination
must pass cross-provenance build, bridge, route/open/close, loader, lifecycle and
device tests on both OSes. A matching `2.1.0-rc.12` label alone is insufficient;
changing any component requires new compatibility evidence and a corresponding
runtime identity decision before candidate evaluation.

- [Sparkling's build command](https://github.com/tiktok/sparkling/blob/c4ce8d25c5ea277e13752d68ff1f2a66f5704240/packages/sparkling-app-cli/src/commands/build.ts)
  separates compilation from copying files into native application assets.
- [Sparkling's multi-page navigation guide](https://github.com/tiktok/sparkling/blob/c4ce8d25c5ea277e13752d68ff1f2a66f5704240/docs/en/guide/multi-page-navigation.md)
  defines each compiler entry as a navigable bundle path and opens it through
  `sparkling-navigation` in an independent native container. Hot Updater must
  preserve that public route while replacing its unmanaged resource selection
  with the currently running verified Release.
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

| ID  | Challenged assumption                                                              | Proposed resolution                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | A generic BuildPlugin makes the entire existing archive path generic               | Reuse BuildPlugin integration; keep RN renaming/filtering out of Lynx handling and native entry discovery. Determine an explicit artifact-handling boundary before freezing the interface. Reject metadata collisions and inspect the actual CLI archive. |
| D2  | Separate backend + OS/appVersion guarantees native compatibility                   | Native owns an immutable compatibility identity and requires an exact match with verified artifact metadata before execution. Server targeting is a separate constraint.                                                                                  |
| D3  | Preserving a file tree guarantees offline prebuilt support                         | Require a proven host resource-addressing contract, release-aware caches and lifetime, and no fallback to another release for managed dependencies.                                                                                                       |
| D4  | Plain JS APIs can call native from any framework execution graph                   | Imports have no native-call side effects. Native calls originate from background JS; native binds readiness to the actual attempt and primary context.                                                                                                    |
| D5  | Missing readiness is equivalent to a crash, or one retry receipt suffices          | Distinguish confirmed startup failures from unexplained exits. Preserve per-Release exclusions across subsequent attempts; a newer failed candidate must not make an older excluded candidate eligible again.                                             |
| D6  | Stabilize the package API before proving native loading and bridge behavior        | Run native feasibility across all six combinations first. Internal adapters and manual local placement are allowed in that future spike; they do not count as OTA completion.                                                                             |
| D7  | Equal framework support requires one binary for all frameworks                     | Share the host integration and scenarios. Keep each scenario's native binary unchanged across A/B; record compatibility separately for each combination.                                                                                                  |
| D8  | Compiler output identity, bundle identity and Release identity are interchangeable | Native owns embedded/minimum IDs. Packaging assigns the OTA bundle ID. Catalog Release IDs identify authorization and remain separate from bytes and startup attempts.                                                                                    |
| D9  | Native startup can be confirmed before rendering or after a timer                  | The resumed native and E2E reviewers independently reproduced premature confirmation; require actual first content plus application readiness for each generation.                                                                                        |
| D10 | Identical scenario names establish equivalent E2E coverage                         | Assert observed native state and actual patch behavior; never synthesize expected results, search unrelated snapshot text, or treat transport timeouts as no-update.                                                                                      |
| D11 | A bundle URL is sufficient for an ordinary Sparkling scaffold                      | The library must also supply verified resource loaders and lifecycle/bridge integration; use a packaged managed host where public builder hooks are unavailable.                                                                                          |
| D12 | A framework-free dependency list makes delivery neutral                            | Explicit artifact/compression/fingerprint contracts must replace common RN filename and Expo-discovery assumptions.                                                                                                                                       |
| D13 | Any manifest-covered `.lynx.bundle` is safe to open as a page                      | Metadata declares a deterministic page-entry allowlist. The packaged router accepts only an exact canonical allowlisted path from the running installation, so background and dynamic-component bundles cannot become pages accidentally.                 |

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
- ReactLynx, VueLynx, and OctaneLynx default A, B, and C fixtures each compile
  two real native entries with the exact logical paths `main.lynx.bundle` and
  `detail.lynx.bundle`. Both pages must contain a release-specific observation
  so acceptance can reject mixed A/B/C output. The two-entry result is required
  from the real compiler output, final archive, and installed tree; generating a
  second file after compilation or simulating navigation inside `main` is not
  acceptable.
- `sparkling-navigation` remains an application JavaScript dependency. The
  package-owned managed-navigation boundary validates its raw inputs and then
  calls the locked upstream `navigate()`; it is framework neutral rather than a
  ReactLynx, VueLynx, or OctaneLynx adapter. All three entry graphs must compile
  and execute that same upstream navigation path without adding a UI framework
  dependency to `@hot-updater/lynx`.

### 5.2 Artifact and identity contract

- Accept compiler output or prebuilt native files that satisfy the declared
  native compatibility, resource-addressing, and readiness contracts.
- A build integration receives the OS, packaging bundle ID, working directory,
  and an empty output directory. It identifies a main entry, supplies an
  explicit deterministic `pageEntries` allowlist, supplies deterministic
  `pageEssentialResources` for every page, and supplies the artifact's declared
  native compatibility identity. `pageEntries` contains every bundle path that
  the packaged host may open as a page, includes the main entry, and does not
  infer pages from file extensions or the rest of the output tree.
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
- Apply finite path-byte, artifact-count, archive-entry, metadata, compressed,
  per-file, and expanded-output limits before allocation or publication. Paths
  must remain portable across iOS, Android, and storage: reject absolute paths,
  backslashes, drive or URL prefixes, empty or dot segments, control characters,
  ancestor/file conflicts, and aliases under the existing common artifact
  namespace. Its collision key remains Unicode NFC followed by locale-invariant
  full uppercase and then full lowercase. The stricter page route grammar below
  does not alter this shared Unicode rule. Packaging, server and native
  regression vectors continue to reject `Straße`/`STRASSE`, Greek final-sigma
  aliases, NFC/NFD aliases, `manifeſt.json` as a reserved `manifest.json` alias,
  and file/directory ancestor aliases in either order.
- Apply all common portable-path rules independently to every `pageEntries`
  value, then apply a stricter route grammar. A page entry is lowercase ASCII
  and matches this exact regular expression:
  `^(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?/)*[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\.lynx\.bundle$`.
  Thus `main.lynx.bundle` and `pages/detail-v2.lynx.bundle` are valid;
  whitespace, uppercase or non-ASCII characters, percent signs, backslashes,
  empty/dot segments, leading or trailing `/`, and leading `./` are invalid.
  The configured input must already equal the npm tarball's
  `normalizePath(path)`, which applies `trim()` and removes repeated leading `/`
  or `./`; aliases accepted only after that normalization are unsupported and
  rejected at the package-owned JavaScript navigation boundary before calling
  upstream `navigate()`.
- Every declared page must name a nonempty regular manifest asset. Preserve and
  compare its spelling byte for byte after validation; build, JavaScript and
  native may not normalize an alias into an accepted route. The existing common
  collision check still runs across the complete artifact namespace, including
  page entries and non-page resources.
- The shared upper bounds are 128 MiB for an archive, 128 MiB for each artifact,
  512 MiB for total expanded files, and 1 MiB for the signed manifest. The Lynx
  sidecar is limited to 16 KiB. These limits apply consistently in packaging,
  server-side delta work, download, extraction, and native verification.
- Order portable artifact paths, fingerprint inputs, and patch rows
  deterministically. Path and fingerprint ordering uses locale-independent
  JavaScript UTF-16 code-unit order: compare unsigned 16-bit code units from
  left to right, and sort a shorter shared prefix first. Patch rows preserve
  their explicit order with a stable identity tie-breaker.
- Archive writers sort entries and normalize portable metadata so equal inputs
  produce equal archives. Promotion revalidates source archive bounds, entry
  types and paths, manifest coverage, and every asset hash before repackaging,
  including unsigned promotion. It records the promoted manifest content hash.
- Integration-owned fingerprint providers constrain source traversal to an
  allowed root, use stable source ordering, preserve explicit symbolic-link
  identity, and reject file or directory mutation during hashing. Fingerprint
  diffs compare the stored prior and newly generated provider results directly.
- Versioned entry metadata binds the bundle ID, OS, main entry, deterministic
  `pageEntries`, `pageEssentialResources`, and native compatibility identity.
  The manifest-covered `hot-updater-lynx.json` sidecar remains schema version 1.
  A current build must serialize the validated page list in locale-independent
  JavaScript UTF-16 code-unit order. The main `entry` must occur exactly once in
  the list. Native readers preserve compatibility with an older schema-version-1
  sidecar only when both `pageEntries` and `pageEssentialResources` are absent,
  treating that absence as `pageEntries: [entry]` and
  `pageEssentialResources: [{ entry, resources: [entry] }]`.
  If the property is present, `null`, a non-array, an empty array, a list with a
  non-string or empty value, an exact duplicate, a collision-key duplicate, a
  missing main entry, or noncanonical order is invalid metadata. Readers reject
  unsupported schema versions and never infer additional pages from archive
  contents. This compatibility rule does not permit a current default Sparkling
  build to omit the two required page entries. The parser validates the array,
  each path, collision uniqueness, and exact main-entry membership before it
  compares the supplied order with a copy sorted by the specified UTF-16
  comparator. It rejects a different order and never repairs metadata by sorting
  it during read.
- When `pageEntries` is present, `pageEssentialResources` is required and is a
  nonempty array of `{ entry: string, resources: string[] }` descriptors. The
  descriptor order and entries exactly equal `pageEntries`; descriptor objects
  have only those two keys. Each `resources` value is a nonempty, duplicate-free
  array of common portable artifact paths sorted with the same UTF-16 comparator.
  It contains the descriptor's page entry and every manifest asset whose
  successful availability is required before that page's first application-ready
  admission. Every path names a regular asset in the same manifest and may appear
  in more than one page's list; the page entry itself remains nonempty.
  Missing/extra descriptors or object keys, missing lists, `null`,
  non-object/non-array values, non-string/empty paths, mismatched or duplicate
  page entries, duplicates or unsorted resources, unsafe paths, or paths absent
  from the manifest invalidate the complete metadata. Supplying only one of
  `pageEntries` or `pageEssentialResources` is invalid.
- The compiler dependency graph is the authoritative source for generated page
  resource lists. A compatible prebuilt integration must declare the equivalent
  lists explicitly at build time. Runtime JavaScript, route query parameters,
  loader observations, and app-ready signals cannot add or remove essential
  resources. Native verifies every declared asset before evaluation and resolves
  every descriptor path through the same context-scoped managed provider during
  admission, whether prefetched or naturally requested. Admission cannot succeed
  until every declared path has a successful resolution receipt and the page
  reaches native first content plus application-ready. An undeclared managed
  dependency does not mutate the descriptor; its resolution is allowed only from
  the same manifest/release, and any miss still fails under the general managed
  dependency rule.
- Generate the OTA bundle ID when packaging, without requiring compiler define
  injection. Compiler build identifiers and catalog Release IDs are distinct.
  Native supplies its embedded bundle identity and minimum accepted bundle ID;
  these must not come from downloaded JavaScript.
- Packaging creates a new Bundle. Promotion or rollback can authorize an
  existing Bundle through a Release and must not repackage it automatically.

### 5.3 Verification and native compatibility

Before evaluating any candidate page, template, main-thread script, or background
script, native must complete the existing archive/manifest integrity checks and
configured signature checks, safely extract files, verify entry metadata, and
match the selected bundle ID, OS and native compatibility identity. The entry
must be confined to the installation and included in the verified manifest.
Missing or mismatched fields fail closed and leave the current release intact.
When native signing is configured, unsigned input must remain unacceptable.

Each native binary embeds its expected compatibility identity. The identity
represents the declared engine/PrimJS, loader/bridge, application native-module,
and managed-page contract. The initial managed-page identity input explicitly
includes support for schema-version-1 `pageEntries`,
`pageEssentialResources`, the locked npm navigation grammar, context-authorized
router/open/close behavior, and full-page generation recreation. Adding this
capability changes the identity. A host with the earlier single-entry identity
therefore rejects a multi-page artifact before evaluation rather than parsing
schema version 1 while ignoring its new fields. A current host accepts the
missing-field `[entry]` compatibility form only when the artifact's declared
compatibility identity otherwise exactly equals that current host; the fallback
does not create a cross-identity migration.

The identity is not a UI framework name. Exact equality is the initial proposal;
unknown compatibility is rejected. A manually maintained identity is acceptable
initially if embedded by the native build and supplied by release tooling, but
its recorded inputs include each independently pinned Sparkling provenance item
and the managed-page contract version.

Identity equality enforces that declared contract; it does not automatically
discover ABI changes that a producer failed to declare. G1 must document the
identity's native source, artifact provenance, invalidating inputs, and ownership.
Pinned toolchain/host device evidence is still required when identities match.
App-version and fingerprint matching remain server targeting; neither replaces
the exact native compatibility check. A selected integration owns native input
discovery and fingerprint generation.

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

The packaged Sparkling router receives the route emitted by
`sparkling-navigation`, validates the expected production scheme and extracts
one bundle path, then requires an exact match in the running installation's
verified `pageEntries`. It creates the target through the same managed host as
the primary page and rewrites only the trusted native load request to
`hot-updater:///<page-entry>`. The route cannot select a Release, Bundle,
installation directory, or arbitrary URL. Traversal, malformed or multiply
encoded paths, duplicate bundle parameters, unknown page entries, and aliases
fail the navigation request before a Lynx context evaluates code.

The production grammar is the exact output of `navigate.ts` from the locked
`sparkling-navigation@2.1.0-rc.12` npm tarball/tag. The independently pinned
`c4ce8d25` iOS source does not define JavaScript route behavior:

- The accepted URL has the exact lowercase ASCII scheme `hybrid` and host
  `lynxview_page`, with no user info, port, fragment, or nonempty path. The first
  query item is exactly one case-sensitive `bundle` parameter, and no `url`
  parameter is present. Case-normalized scheme or host aliases and a reordered
  direct-native query are rejected even if a platform URL parser would otherwise
  treat them as equivalent. A nondefault/custom `baseScheme` is not a production
  OTA extension point: native accepts only the effective
  `hybrid://lynxview_page` route. A development `url=` route, another
  scheme/host, and zero or multiple `bundle` values are rejected by the managed
  production router.
- The package-owned, framework-neutral Sparkling navigation boundary receives
  the raw `path`, computes the tarball's exact
  `path.trim().replace(/^(?:\.\/|\/)+/, "")` result, and requires byte equality
  with the input before it delegates to the actual upstream `navigate()`.
  Whitespace and leading `/` or `./` are therefore rejected rather than accepted
  as aliases. Native does not strip prefixes or trim after decoding; an empty
  result or any value outside the ASCII page-entry grammar is rejected.
- Parse the raw query once as UTF-8 `application/x-www-form-urlencoded`, reject
  malformed escapes, and decode each value exactly once. Re-encoding each
  decoded name/value with the tarball's WHATWG `URLSearchParams.toString()` rules
  must reproduce its raw query component byte for byte. That implementation
  leaves form-encoded spaces as `+`; the managed contract must not rewrite them
  to `%20`. Required vectors include `title=Second+Page` for `Second Page` and
  `value=a%2Bb` for `a+b`; a direct `title=Second%20Page` route fails canonical
  byte reproduction. Native never percent-decodes the resulting bundle path
  again, so `%252f` cannot alias `/`, and the once-decoded bundle value must
  exactly equal one canonical allowlisted `pageEntries` value.
- Apply the same byte and count limits before calling upstream `navigate()` and
  again at the native bridge before any router or stack mutation. The complete
  raw route, including its query, is at most 4,096 UTF-8 bytes. It contains at
  most 32 custom query parameters, excluding the one required `bundle` item.
  Every decoded query key is at most 128 UTF-8 bytes, every decoded value is at
  most 1,024 UTF-8 bytes, and the sum of the UTF-8 byte lengths of all decoded
  keys and values, including `bundle`, is at most 2,048 bytes. Reject a request
  that exceeds any limit; do not truncate, drop parameters, or permit iOS and
  Android parsers to count different representations.
- Reserved `bundle` and `url` values from navigation `params` are not forwarded.
  The managed boundary additionally rejects query keys `baseScheme`, `replace`,
  `replaceType`, `useSysBrowser`, `animated`, `interceptor`, and `extra` so an
  option cannot be smuggled through `options.params`. Other query items are
  retained in their original order and passed to the new page as string
  parameters only after the route is authorized. They cannot replace the managed
  bundle URL or enter the route-selection/options channel. Duplicate custom names
  are rejected because the locked npm tarball's `navigate.ts` emits at most one
  value for each object key.
- The managed native `OpenOptions` surface is closed. `replace` may be absent or
  exactly `false`; `true` is rejected because every successful open pushes one
  page. Any `replaceType` or `interceptor` presence is rejected. `useSysBrowser`
  may be absent or exactly `false`; `true` is rejected. `animated` may be absent
  or a boolean and controls presentation only; it cannot change route parsing,
  source authority, selection, installation, generation, stack identity or
  recovery, and recreation uses the host's fixed transition policy. Upstream
  `navigate()` removes `extra`; native rejects `extra` or any unknown option if
  supplied through a direct `open()` call. A custom base, system-browser request,
  interceptor or replacement request cannot bypass the managed router. The
  package-owned JavaScript boundary rejects these inputs before calling upstream
  `navigate()`, and the packaged native bridge repeats validation before any
  Sparkling system-browser, interceptor, replacement, or host-router handler can
  run. Direct `open()` therefore cannot reach an alternate ownership path.

Authorization also binds the request source. The pipe/bridge context supplied
to the router must map to a live managed container owned by the same host and
current generation. The router does not use a process-global top container to
confer authority. A missing, unmanaged, retired, closing, or old-generation
source context receives a stale-source failure and cannot open or close a page,
even if its route text is otherwise valid.

Page resolution uses only the immutable artifact pinned to the current managed
generation. It must not inspect a staged `next` selection and must not fall back
to embedded files, another installed Release, the delivery origin, a development
server, or Sparkling's unmanaged template provider when an allowlisted managed
page is missing or fails verification. Query values intended as page data may
be forwarded after the bundle path is validated, but they cannot override the
managed page or resource URL.

The iOS Sparkling template/resource provider and Android Sparkling template,
generic, image, font, external-JavaScript, and dynamic-component providers must
all receive the same context-scoped managed resolver. `pageEntries` is an
execution allowlist. The manifest-covered
`pageEssentialResources` descriptor whose `entry` equals the page entry is the
sole authoritative first-admission resource list for that page. A detail page
opened later uses its own list and must not add those resources to the primary
context's startup requirements, because doing so would block confirmation before
navigation.

The packaged integration must preserve Sparkling's real full-page container
model. On iOS each route is an actual `SPKViewController` in the packaged native
navigation stack. On Android each route is an actual packaged full-page
Sparkling Activity, or an upstream-equivalent Activity container with the same
lifecycle and back-stack semantics; two Lynx views divided inside one Activity
are not evidence of page navigation. Route open pushes one full page. Native
back and `sparkling-navigation.close()` pop the authorized top page, retire its
context and leases, and reveal the preceding page. A close request from a page
that is not the live authorized top cannot pop another page.

The managed native stack contains at most 16 pages, including the primary page.
The native bridge rejects a seventeenth push before invoking an upstream open,
creating a container, or mutating the logical or platform stack. Transition and
recovery capture and reconstruct only a valid stack of at most 16 pages; an
oversized retained stack fails closed rather than being partially restored.

Installing B must not change the active managed generation's selected release or
overwrite its files. Secondary containers use the same selected release as the
primary context. Opening `detail.lynx.bundle` therefore creates a different
context identity but retains the primary page's process, generation, Bundle,
Release, installation, and resource lease. Resource caches distinguish release
and generation identity, and
cleanup retains directories referenced by live contexts, patch preparations, or
in-flight resource requests. Only the explicit transition in section 5.6 can
replace a live managed generation.

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

Every newly opened secondary page has a first-load admission window bound to its
source generation, ordered stack position, page entry, Bundle, Release, and a
native page-attempt identity recorded before its template evaluates. Admission
requires native first content, successful loads of that page's declared
essential resources, and the page's application-ready signal. The packaged Sparkling host records the page's own entry through the managed
loader before template evaluation, because Sparkling `kit.load()` /
`renderTemplateUrl` is not itself a managed-resource observation. Other declared
essential resources still have to be observed from actual engine loads.
A secondary may
use the same readiness bridge as the primary, but native interprets it only as
page readiness: it cannot consume the primary launch transition or confirm a
Release. Repeated page readiness is idempotent, and stale or different-page
signals have no authority. Satisfying admission atomically commits `admitted`.

Each page attempt has exactly one of four durable terminal states: `admitted`,
`verified-fatal`, `authorized-cancel`, or `process-interruption`. No transition
or lifecycle path may introduce a fifth state. While admission is pending, native
back on the actual top full-page container and
`sparkling-navigation.close()` from that same live top source are authorized
user cancellations. Native back commits `authorized-cancel` with exact reason
`nativeBack`; JavaScript close commits `authorized-cancel` with exact reason
`sparklingClose`. Both records carry `transitionId=null` because no managed
transition applies. A supplied
`containerID` must equal both the source container and current native top; it
cannot close another page. Native commits the cancellation and removes that
logical stack entry before retiring its context and leases. Cancellation does
not suppress a Release or add Bundle crash history. `animated` is boolean
presentation state only. Back/close from a stale,
non-top, unmanaged or different-generation source is rejected and cannot cancel
another attempt. Cancellation and interruption use the same serialized durable
state transition: if the cancellation commit wins, restart observes
`authorized-cancel`; if the process dies first, restart observes
`process-interruption`. Neither outcome may be written twice.

Primary Release confirmation cannot commit while any secondary attempt in that
pre-confirm generation remains pending. The secondary must first reach one of the
four terminal states, or the whole generation must be replaced by an accepted
managed transition that atomically writes `authorized-cancel` as described
below. An `admitted` or authorized close/back cancellation clears the pending
gate; `verified-fatal` invalidates the startup attempt, and
`process-interruption` follows recovery. A late primary ready signal cannot race
past this gate.

On process start, a durable page attempt with no terminal state is atomically
committed as `process-interruption`. If an OTA Release was still pending, it
participates in the existing unconfirmed-startup outcome: suppress that Release
ID and recover the
captured ordered logical stack and parameters on an eligible complete selection,
without adding Bundle crash history unless `verified-fatal` was also
recorded. If an OTA Release was already confirmed, record a distinct
confirmed-Release page-admission interruption, suppress that Release for
automatic selection, do not classify the interruption as a verified Bundle
crash, and reconstruct the captured stack against the next eligible complete
selection. For an embedded selection, record the corresponding page/process
interruption without Release suppression or blacklisting the built-in Bundle,
then recover another eligible complete selection when one exists; otherwise fail
closed instead of reopening the interrupted page automatically. A page already
admitted before process death has no pending admission failure and follows
ordinary restart behavior.

Every terminal-state commit invalidates the page-attempt token before teardown,
cancels or drains its resource work, and releases its leases only after callbacks
can no longer mutate state. Late first-content, resource, ready, close or error
signals from an attempt in any of the four terminal states, or from a retired or
previous-generation attempt, are stale no-ops with an observable rejection
result. Recovery consumes each durable `process-interruption` once, so repeated
starts cannot repeat suppression or reanimate the abandoned attempt.

If detail first load fails before the primary Release is confirmed, the failure
is part of the current generation's pending startup attempt. Native durably
records the generation and page attempt as `verified-fatal`. For an OTA selection
it adds the Bundle to crash history and the Release ID to durable
automatic-selection suppression; for an embedded selection it records the
embedded attempt without blacklisting the native built-in Bundle identity. It
then retires every page in
that generation and reconstructs the captured ordered logical stack and
parameters against an eligible prior confirmed Release or the compatible
embedded Release. If that selection cannot supply every retained page, recovery
fails closed as one generation rather than reopening a partial stack. A failed
embedded generation is not immediately reopened: native uses a different
eligible complete selection or fails closed when none exists. The primary cannot
confirm after that detail failure, and a newer candidate cannot make the failed
Release silently eligible.

If a new detail page first load fails after the Release was confirmed, native
does not classify it as an unrelated post-startup application error. It durably
records `verified-fatal` with the confirmed Release, page entry and
attempt. For an OTA selection, it makes that Release ineligible for automatic
selection and records its Bundle in crash history. For an embedded selection, it
records the failure without Release suppression or blacklisting the built-in
Bundle. Native retires the whole generation and recovers the retained ordered
stack and parameters against the next eligible complete selection. If recovery
cannot supply every retained page, it fails closed as one generation rather than
reopening a partial stack. The earlier confirmation remains audit history but no
longer makes a failed OTA Release eligible. A failed embedded generation is not
immediately reopened; when no different eligible complete fallback exists, the
host records the terminal outcome and fails closed.

Device evidence must cover both timings on both OSes: detail failure before
primary confirmation and the first detail open after Release confirmation. It
must show the page-attempt identity, failure before page admission, one durable
failure/suppression mutation, retirement of all generation contexts, recovery
selection, rebuilt full-page stack, and absence of a late primary or secondary
signal that confirms or re-enables the failed Release. It must separately cover
authorized native-back/close cancellation while detail admission is pending and
process death with a pending detail both before and after Release confirmation,
including the exact cancellation/interruption state, crash-history distinction,
stale-signal rejection and resulting stack. A separate pending-detail transition
vector must show atomic `TRANSITION_ACCEPTED` plus
`authorized-cancel` records with exact reason `managedTransition` carrying the
same transition ID,
followed by fresh new-generation page attempts.

The native launch transition is a durable one-shot receipt. The first valid
confirmation after activation or recovery reports the exact source and target
Bundle/Release selections. Consuming it and confirming startup are one atomic
state mutation. Repeated readiness calls are idempotent and cannot replay a
prior `UPDATE_APPLIED` or `RECOVERED` result.

SDK-free prebuilt files may be packaged, but confirmed OTA operation also requires
an application signal or a host that proves the same startup conditions. Merely
installing such files is not evidence of full support.

| Event                                                                            | Durable outcome                                                        | Next startup behavior                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Installed but not evaluated                                                      | Installed candidate; no startup attempt                                | Candidate may be evaluated normally                                     |
| Primary candidate evaluation starts                                              | Pending attempt bound to release, native binary and managed generation | Await confirmation or classify its outcome                              |
| Valid native observation and ready signal                                        | Confirmed release                                                      | Retain it while eligible and compatible                                 |
| Verified fatal template/JS/native startup failure                                | Failed attempt and existing crash-history semantics                    | Recover to an eligible confirmed release or compatible embedded release |
| Pending attempt found without confirmation or recorded fatal failure             | Unconfirmed termination, separate from crash history                   | Recover and suppress automatic restaging of that Release ID             |
| Error after Release confirmation and after every opened page completes admission | Outside the initial startup/page-admission rollback guarantee          | Do not promise rollback of arbitrary later application errors           |

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

### 5.6 Immediate activation through managed runtime recreation

`HotUpdater.reload()` uses the library's host integration to replace the entire
managed runtime generation on both platforms while keeping the app foregrounded.
This is an in-process transition, not an OS process restart. It must not be
implemented by `exit(0)`, an Android restart trampoline, a driver relaunch, a
fixed timer, or an application-defined native workaround. A URL accessor or a
reload of only the main template cannot satisfy this operation.

For the default managed host, the `reload()` native call resolves only after
native has validated, durably persisted, and serialized one transition with its
transition ID, authorized target selection, trigger, source generation and
captured logical stack. It resolves to the caller as `TRANSITION_ACCEPTED` before
retiring that caller's context. This is an acceptance acknowledgement; it never
claims that reconstruction, startup, confirmation or recovery succeeded, and
callers must not depend on code after `await reload()` continuing once acceptance
is delivered. If validation, authorization or persistence fails, native rejects
the call, records no accepted transition, and leaves the old generation and
selection running unchanged.

That acceptance transaction also terminates every still-pending page attempt in
the authorized source generation. Each attempt receives the existing terminal
state `authorized-cancel`, exact reason `managedTransition`, and the accepted
transition ID. Native captures the logical stack before retirement and retains
those pending page entries and parameters for reconstruction; unlike
`nativeBack` or `sparklingClose`, `managedTransition` cancellation does not pop
them. It does not suppress a Release or add Bundle crash history. Reconstruction
creates fresh page-attempt identities in the new generation. If transition
acceptance rolls back, none of these cancellations commit and the old attempts
remain pending.

This rule applies identically to every accepted, source-authorized default
`reload`, `resetChannel`, and forced-activation transition. All pending-attempt
terminal records and the accepted transition must commit in the same durable
transaction; none may become visible independently.

After acceptance, the old context cannot receive a later success or failure.
Actual completion is authoritative only when a fresh generation produces actual
native first content, resolves its declared essential resources, sends app-ready,
and atomically consumes the durable transition as `UPDATE_APPLIED` or
`RECOVERED`. Reconstruction or startup failure is persisted against that same
transition and enters the recovery policy; it cannot reject or resolve the old
Promise retroactively. A terminal fail-closed outcome is also durable even when
no application context survives to consume it.

Every accepted transition that creates a replacement runtime generation must
write a durable startup attempt before that generation begins evaluation. The
attempt carries the accepted canonical UUID transition ID and remains bound to
the exact target selection. This also applies when the accepted target is the
already confirmed Release or built-in bundle. A process exit before readiness
therefore consumes the interrupted attempt through recovery instead of starting
the same accepted transition repeatedly. When recovery changes the running
identity, native atomically consumes the attempt and accepted transition and
persists a `RECOVERED` launch receipt with the same ID before exposing the
fallback. A second exit before the fallback is pinned cannot lose or replace
that receipt.

An exact-identity replacement that reaches readiness has no public launch
movement to report. Native retains the accepted ID internally for startup and
failure correlation until readiness atomically clears the startup attempt,
accepted transition, and any launch receipt. The strict JavaScript result is
then `transition: null` and `transitionId: null`; native must never return an ID
with a null transition. Exact-identity process recovery likewise consumes the
internal attempt and transition without exposing a synthetic launch movement.
That exception applies only when the transition-bound primary startup attempt
is the sole interrupted record. A pending page attempt or generation failure is
a real generation interruption even when the primary target still equals the
confirmed Release. Native suppresses the failed Release, selects the final
eligible installed artifact that can reconstruct the complete retained stack,
and atomically persists `RECOVERED` from the failed selection to that fallback.
The receipt reuses the accepted transition ID and must survive another process
exit before the fallback is pinned.
Persisted launch and managed transition IDs must use canonical UUID syntax.
Legacy launch receipts without an ID are backfilled atomically before exposure,
while malformed or conflicting IDs fail closed.

Concurrent default transition requests are serialized in native. Exactly one
request may create the accepted transition; every later `reload`, `resetChannel`
or forced-activation request for the source generation rejects with
`TRANSITION_IN_PROGRESS` and does not coalesce, overwrite scope state, capture a
second stack or start another generation. Calls from the source generation after
acceptance are stale and rejected.

A custom host may replace default reload behavior only by calling
`HotUpdater.setReloadBehavior("custom", handler)` with a required handler. In
custom mode, `reload()` returns the handler's Promise because the library does
not retire the managed caller automatically; that result is the custom handler's
result and is not a managed-generation completion receipt or evidence for the
default OTA contract. The public API does not accept ignored `reload` or
`processRestart` behavior values.

Each managed container retains its logical page entry and navigation parameters,
not an absolute path into its old installation. Reload and recovery rebuild the
same retained ordered page stack against one newly selected verified artifact.
The host records the bottom-to-top logical page entries, each page's forwarded
string parameters, and the top-page identity before retirement, then recreates
that exact order and top after the replacement is authorized. Main and
detail receive fresh context identities in one new generation and must resolve
to that generation's matching page entries. If the selected artifact cannot
reconstruct every retained logical page, reconstruction fails as one generation;
the host must not keep an old detail page beside a new main page.

`resetChannel()` uses the same acceptance boundary. In one durable native
transaction it persists the default channel, clears the switched scope's
accepted, confirmed, staged, pending and prior transition state, and creates the
new serialized reset transition before resolving the old context's existing
success value. That value has `TRANSITION_ACCEPTED` semantics only. If the
transaction fails, it rejects and preserves the prior native
scope and running generation. The JS client invalidates its cached native
snapshot before issuing the request and keeps it invalidated on either result;
after a rejection, the
next query reads the unchanged authoritative native state, while after acceptance
only a new-generation query and launch receipt establish the result. Reset never
reports recreation success to the old context.

The library owns a serialized transition with these requirements:

1. Under the transition lock, validate authorization, capture the authorized next
   selection and logical stack, atomically persist the transition, and write
   `authorized-cancel` with exact reason `managedTransition` plus its transition
   ID to every pending source-generation page attempt. Reject and keep the old
   generation and attempts intact if any part fails. Return only the durable
   acceptance acknowledgement to the caller.
2. After acceptance delivery, stop new work in the old generation; invalidate
   its module contexts, readiness callbacks and stale installation authority.
   Destroy every managed container and its runtime context. Cancel or drain old
   resource requests and retain their files until all references are released.
   Ordinary remote application data remains outside this managed resource lease.
3. Create a new generation with fresh context identities and one designated
   primary. Persist its startup attempt before any candidate script or template
   executes. Reconstruct the retained logical page stack, including main and any
   open detail page, from the same selected release.
4. Confirm only after actual native first content and essential application
   bootstrap succeed. Signals from the previous generation cannot confirm it.
5. On fatal startup or failed reconstruction, classify and persist the outcome,
   then reconstruct an eligible confirmed or embedded fallback through the same
   host path. Preserve unconfirmed Release exclusions and Bundle crash history.

Installation still only stages an update. A non-forced update is not reloaded
automatically merely because a `next` selection exists. After a forced update is
fully installed and its `next` selection is durably authorized, native submits
the same serialized transition trigger. If transition acceptance fails, the
verified update remains staged, the old generation keeps running, and the caller
receives an acceptance error; installation failure never triggers a transition.
If acceptance succeeds, the old caller can observe only
`TRANSITION_ACCEPTED`; the new generation later reports `UPDATE_APPLIED` or
`RECOVERED` through its launch receipt and actual readiness. Next-launch
activation and actual OS restart recovery continue to work independently of
immediate activation.

Native receipts must distinguish binary identity, OS process identity, managed
generation identity, release identity, and startup attempt. Device tests must show
the process stayed alive during immediate activation, the generation changed,
all managed contexts changed together, and stale callbacks remained ineffective.
They must also identify the actual iOS `SPKViewController` or Android full-page
Activity container for each page and prove the ordered entries, forwarded params,
native top page, route-open result, native back result, and close result before
and after reload and recovery. Different context IDs alone are insufficient.

Runtime evidence has one cross-platform identity representation. Every runtime
event, native runtime receipt, persisted replay, and six-cell evidence item
contains `processId` as a non-null canonical positive decimal JSON string matching
`^[1-9][0-9]*$`; a JSON number, zero, sign, leading zero, empty string, missing
value, or null is invalid. All events and receipts emitted by the same live OS
process use the same exact value. Managed reload keeps it unchanged. OS process
replacement changes it, and replay preserves the original event's value rather
than substituting the process that reads the journal.

The identity portion of every managed-generation runtime event has these exact
types. Receipts and replay use the same type and nullability whenever they carry
the corresponding field; they may not coerce a number or substitute an empty
string:

| Field           | JSON contract and identity semantics                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimeId`     | Nonempty string identifying the exact native/artifact runtime compatibility contract; never null for managed-generation evidence.                                                                                                       |
| `generationId`  | Nonempty string allocated once per managed generation; never null for managed-generation evidence, shared by every page in that generation, and changed by recreation or recovery.                                                      |
| `contextId`     | Nonempty string for an event or receipt attributed to one live or retired page context; explicit null for a generation-wide item with no single context. It is never inferred from `primaryContextId`.                                  |
| `pageAttemptId` | Nonempty string after a secondary page attempt is allocated and on every event/terminal receipt for that attempt; explicit null when the item does not describe a page attempt. A reconstructed page receives a new value.              |
| `transitionId`  | Nonempty string for an accepted managed transition and every cancellation, completion, failure, recovery, or replay attributed to it; explicit null when no accepted transition applies. Rejection before acceptance cannot invent one. |
| `bundleId`      | Nonempty string for the selected embedded or OTA Bundle; never null for managed-generation evidence.                                                                                                                                    |
| `releaseId`     | Nonempty string for an OTA Release, including promotion or rollback; explicit null only for the embedded selection. Empty string and omission are invalid.                                                                              |

Except for the canonical decimal grammar of `processId`, identity strings are
opaque and compared byte for byte. Producers and consumers do not trim,
normalize, case-fold, parse, or stringify them.

Every managed-generation runtime event `details` object contains all eight
identity keys above, including `processId`; nullable fields are present as JSON
null rather than omitted. Event-specific arrays such as `contextIds` contain
only nonempty strings and do not replace the scalar contract. Native API results
outside managed runtime evidence carry only the identity fields defined by their
own result schema, but any such field obeys the same type and null meaning.

Android Sparkling records an `engineDiagnostic` runtime event synchronously from
the actual live `LynxViewClient.onReceivedError` callback through that
generation's event sink. Its details contain the full runtime identity, nonempty
`contextId` and `attemptId`, Boolean `fatal`, integer `code` and `subcode`,
nonempty `type`, and `path` as the exact canonical managed relative path of at
most 1,024 UTF-8 bytes. The path is derived from the exact
`hot-updater:///` source and must belong to the current managed installation.
Malformed, unowned, or retired-generation diagnostics are not trusted.

The cross-platform runtime evidence event contract bounds each event name to
128 UTF-8 bytes and its serialized `details` JSON value to 64 KiB (65,536 UTF-8
bytes). The canonical persisted journal is one compact RFC 8785 JSON
Canonicalization Scheme document with exactly this logical envelope and no
additional envelope fields:

```json
{ "events": [], "nextSequence": "1", "schemaVersion": 1, "truncated": false }
```

`schemaVersion` is the JSON number `1`. `nextSequence` is a base-10 positive
integer string matching `^[1-9][0-9]*$`, with no sign or leading zero, and is
incremented with arbitrary precision. `truncated` is a JSON boolean. `events` is
an array ordered from oldest to newest. Each item has exactly the keys
`sequence`, `name`, and `details`: `sequence` uses the same canonical decimal
string form, `name` is a nonempty JSON string, and `details` is an inline JSON
object. The retained event sequences are strictly increasing and contiguous,
and the last one is exactly `nextSequence - 1`; an empty array is valid only for
initial or corrupt-state repair and requires `nextSequence="1"`. Details are
never encoded as JSON text, bytes, platform `Data`, or base64. When
`truncated=false`, a nonempty journal begins at sequence `"1"`; a repaired
`truncated=true` journal may begin again at `"1"`, and an evicted journal begins
at its retained suffix.

The allowed JSON domain for `details` is an object whose values recursively are
null, booleans, valid Unicode strings without unpaired surrogates, finite JSON
numbers accepted by RFC 8785, arrays, or objects with unique string keys.
Undefined values, non-finite numbers, duplicate object keys, platform-specific
objects, and values that RFC 8785 cannot canonicalize are invalid. The event name
is measured as its UTF-8 string bytes. The details limit is measured over the
canonical UTF-8 bytes of the inline `details` object alone. The whole-file limit
is measured over the canonical UTF-8 envelope bytes with no BOM or trailing
newline. The exact event-field maxima are accepted. A name or canonical details
value one byte over its limit, or any invalid value, is rejected without journal
mutation.

A missing file denotes the initial logical state above. The canonical append
algorithm is identical on iOS and Android:

1. Validate the event name and details domain, canonicalize details, enforce the
   128-byte and 65,536-byte field limits, and stop without consuming a sequence
   on failure.
2. Copy the current envelope, assign its current `nextSequence` string to the new
   event, increment `nextSequence`, and append the defined inline event object.
3. Canonicalize and count the complete candidate envelope. If it exceeds 256
   events or 16 MiB (16,777,216 bytes), set `truncated=true`, remove exactly the
   oldest event, then recanonicalize and recount. Repeat this step until both
   limits hold. If the candidate still cannot fit after all prior events are
   removed, reject without mutating the stored journal.
4. Atomically persist exactly the final canonical bytes. Persistence failure
   consumes no sequence, restores the in-memory copy to the previous durable
   envelope, and leaves that envelope authoritative.

Journal capacity is therefore a retention limit, not an event-input rejection
limit. An exact 256-event or exact 16-MiB journal remains valid, and its next
valid append succeeds with the minimum oldest-first eviction and atomically
persisted `truncated=true`. Native never writes an over-limit intermediate file.

Native checks persisted file size before parsing. Any extra or missing
envelope/event key, wrong type, noncanonical decimal string, sequence gap,
noncanonical file bytes, count or size violation, malformed JSON, invalid details
domain, runtime-identity contract violation, or event-field violation makes the
file corrupt. No event or sequence from a corrupt file is exposed. Native
atomically replaces it before future use with these exact canonical bytes:

```json
{ "events": [], "nextSequence": "1", "schemaVersion": 1, "truncated": true }
```

The repaired public snapshot reports null oldest/latest sequences. If repair
cannot be persisted, the journal remains unavailable and rejects snapshots and
appends rather than using a memory-only replacement. Once `truncated` becomes
true, reload, resetChannel, recovery, process restart, or a Release or generation
transition cannot clear it; only removal of the containing application data
starts a new journal lifetime.

The public snapshot contains exactly `schemaVersion`, `oldestSequence`,
`latestSequence`, `truncated`, and `events`. It reports schema number `1`, copies
the persisted boolean and ordered event values, derives oldest/latest from the
first/last retained sequence strings or returns null for an empty array, and
never exposes `nextSequence`. This prevents persisted aliases such as
`latestSequence`, `oldestSequence`, `rolledOver`, or `dropped`, numeric sequence
values, and encoded details payloads.

An Android font error 302 is recoverable in E2E validation only when exactly
one eligible current-PID log diagnostic has one same-identity journal chain
ordered as `generationWillEvaluate`, `generationStarted`, `engineDiagnostic`,
`fontLoaded`, and confirmed `jsReady`. The diagnostic must be nonfatal code 302,
subcode 30201, type `font`, and have the same canonical path as the log; the
font event must carry a lowercase SHA-256. Any fatal or retirement event, later
generation boundary, missing or additional diagnostic between evaluation and
readiness, diagnostic before generation start, or identity mismatch fails
closed. The screen action receipt must equal
`generation-events -> <latestSequence>`, its marker must equal the marker the
driver awaited, and its complete snapshot must match the canonical package
journal events, truncation flag, bounds, and derived next sequence exactly.

E2E records `TRANSITION_ACCEPTED` plus its transition ID from the native
acceptance log in the nonproduction harness, then stops using the old Promise as
a completion signal. The driver waits for the
replacement primary page's real content marker, app-ready admission, and one
durable `UPDATE_APPLIED` or `RECOVERED` launch receipt with the same transition
ID, target Release and new generation. It also proves that the old context is
retired. A reconstruction failure passes only when recovery produces the matched
`RECOVERED` receipt and content/readiness, or when the separate nonproduction
native harness observes the durable terminal fail-closed record. This does not
add a production control runtime that survives generation replacement.

### 5.7 Verified delta installation

Reuse the engine-neutral artifact response contract: optional complete archive
URL/hash, manifest URL/trust token, and per-asset `ChangedAsset` file or BSDIFF
descriptors. A manifest installation requires a complete valid manifest contract;
partial descriptors fail closed. Preserve a supplied manifest trust token across
archive fallback. Configured signing must apply to the manifest and every managed
target file regardless of delivery path.

Native alone chooses the verified running installation used as the patch base.
JavaScript must not nominate an arbitrary filesystem path or confer base trust.
Require matching base Bundle identity and base-file hash, verify patch bytes,
apply within bounded output limits, and verify the resulting target hash. Reuse
unchanged files only when covered by the verified base and target manifests.
Download and decode changed files according to their explicit compression; empty
managed files are valid when the manifest permits them.

Build the complete target in a private attempt-owned directory. Reject path
traversal, symlinks, collisions, unlisted files, excessive expansion, wrong entry,
wrong platform/runtime, invalid signatures, and stale selection authority before
atomic publication. The persisted installation must remain independently
verifiable on later launches even when no complete archive was downloaded.

An unusable patch may fall back to an authorized complete file or archive. Logs
must identify the actual path used. Cancellation propagates and removes only the
owned preparation; it must not trigger a fallback or publish partial files.
Patch failures must preserve the currently running installation and its leases.
Do not count archive fallback as a passing BSDIFF-application assertion.

The current engine-neutral manifest has one `patchAssetPath`. For the default
two-page Lynx artifact, `main.lynx.bundle` may be that BSDIFF asset while
`detail.lynx.bundle` is delivered as a complete changed asset. That transfer
shape remains a delta only when the declared main patch is actually applied.
Native must still reconstruct and verify the complete target manifest, including
the detail page and all dependencies, before one atomic publication. Main and
detail never become independently installable or activatable units. Extending
the common protocol to multiple patch assets is separate from required
multi-page correctness.

Acceptance includes an explicit no-archive mixed-delivery vector. Its artifact
response offers an authenticated target manifest, an actual BSDIFF descriptor
for changed `main.lynx.bundle`, and a complete raw changed-file descriptor for
changed `detail.lynx.bundle`, with no usable archive URL/hash fallback. Native
must apply the main patch, download the detail file, reconstruct all unchanged
assets, and verify every target hash and the complete metadata before publishing
the target once. A missing, truncated, wrong-hash, wrongly signed, or otherwise
invalid detail changed file rejects the entire target, removes the private
attempt, leaves the running Release and every live page unchanged, and cannot be
reported as patch success. Exercise the same mixed representation on the reverse
C-to-B and B-to-A chain wherever those target pages changed.

The required chain covers forward A-to-B and B-to-C deltas and reverse C-to-B
and B-to-A deltas. Each reverse transition must use and prove the declared patch
against the exact active base rather than relying on archive fallback.

## 6. Proposed milestones and gates

### G0 — Review this PRD (completed)

Review the support targets, responsibility boundaries, compatibility invariant,
managed-generation activation, conservative startup policy, and milestone order.
The user explicitly approved execution after the adversarial review. G0 is
complete through that authorization; subagent agreement alone did not complete it.

### G1 — Native feasibility and contract decisions

After G0 review, use pinned Sparkling hosts and all three production toolchains.
Internal build adapters and manual local placement of B are valid spike tools;
the full OTA engine is not a prerequisite for this stage.

Required evidence across all six combinations:

- Actual native binary identity and resolved Lynx/PrimJS/module versions.
- Embedded A and manually placed B decode and run offline with all managed
  resource categories used by the fixtures; main and detail navigate through
  the managed router, and same-name A/B assets cannot mix.
- Safe SDK imports across execution graphs, background module calls, async
  success/error transport, and correctly attributed readiness.
- A supported resource URL/cache contract, native-owned compatibility identity,
  and versioned entry metadata design with authoritative per-page essential
  resources. Demonstrate old-host/capability and provenance mismatch rejection
  before candidate execution.
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
- Replace the common CLI's fixed Bare/Rock/Expo build enum with an
  integration-owned setup/doctor/fingerprint/remediation descriptor. A Lynx-only
  fixture must complete the generic CLI flow without installing or inspecting
  React Native or Expo.
- Enforce the neutral-package dependency and source-policy boundary described in
  section 2.2, while RN regression fixtures prove unchanged RN/Hermes behavior
  through the RN integration.
- Provide reproducible ReactLynx, VueLynx and pinned-source OctaneLynx entrypoints,
  each producing real `main.lynx.bundle` and `detail.lynx.bundle` A/B/C output,
  with shared host integration and documented native prerequisites.
- Use real framework output through the existing CLI deployment/archive path;
  inspect both page bytes, `pageEntries`, `pageEssentialResources`, the final
  archive, and the manifest, not just the BuildPlugin return value.
- Preserve names and hashes, bind metadata correctly, reject reserved-file
  collisions and invalid paths, and preserve previous successful output after a
  compiler failure.
- Package the Sparkling router and native page stack with the optional Sparkling
  host integration. The production application retains ordinary registration,
  configuration, and mount wiring only; its source must not implement a
  Hot-Updater-specific router, loader, or test workaround.
- Resolve each Sparkling component from the independent authoritative provenance
  in section 3: iOS source at `c4ce8d25`, the integrity-locked npm navigation
  tarball/tag at `bb066d6`, and Android core/method Maven `2.1.0-rc.12` plus the
  verified npm-packaged navigation source. Record source/artifact checksums and
  fail validation on any unrecorded substitution. Do not infer cross-component
  content equality from a version label; require the cross-provenance native
  compatibility tests before accepting the combination.
- Verify native page selection with multiple managed page entries and test the RN
  integration boundary where shared code changes. Do not widen native refactors
  beyond demonstrated reuse needs.

G2 is integration evidence, not completion of production OTA support.

### G3 — OTA installation and recovery

Implement archive/delta download, verification, safe staging, atomic
installation/selection, next-launch and managed-generation activation,
confirmation and recovery. Preserve and reconstruct the logical page stack,
keep every page on one generation and Release, and make reverse rollback use the
same managed route boundary. Cover secondary first-load failure before and after
Release confirmation, pending-admission process interruption and authorized
back/close cancellation, managed-transition cancellation, stale-signal cleanup,
option/path rejection,
stale-source route rejection, and exact ordered stack/parameter/top
reconstruction. Verify the default reload/reset/forced-activation acceptance
boundary, persistence rejection, concurrent-call result and matched
new-generation launch receipt. Verify route/query/stack limits and bounded,
fail-closed runtime-journal retention, canonical persisted bytes, and public
snapshot projection on both platforms. Reject numeric or inconsistently nullable
runtime identities and verify process/generation/context changes at their defined
boundaries. Complete the acceptance matrix in section 7 on unchanged release
binaries, without a development server.

### G4 — Subsequent proposals

Use G3 evidence to propose analytics telemetry, independent per-page delivery
policy, and additional navigation policies separately. Runtime-neutral CLI
onboarding and doctor behavior are part of G2 because the common product boundary
cannot claim Lynx support while requiring React Native. The default two-page
contract, delta delivery, and engine-neutral native fingerprint ownership are
required initial scope.

## 7. Acceptance evidence

Each run records the native binary identity, resolved runtime and compiler
versions, A/B/C bundle and Release IDs, both page/resource hashes, resource-loader
observations, and native activation/recovery logs. Web preview, compilation and
archive inspection do not prove device OTA.

| Scenario                                                                           | Required result                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Embedded A → installed B → offline process restart                                 | B entry and all managed dependencies load from B                                                                                                                                                                                                                                                       |
| Valid B confirmation → another restart                                             | B remains confirmed                                                                                                                                                                                                                                                                                    |
| Fatal startup error / unexplained pre-ready termination                            | Distinct history and exclusion outcomes; eligible confirmed or embedded fallback                                                                                                                                                                                                                       |
| B exits unconfirmed, then C exits unconfirmed                                      | Later selection cannot silently re-enable B                                                                                                                                                                                                                                                            |
| New authorized Release ID references previously unconfirmed cached bytes           | Fresh attempt; no inherited readiness or cached-install/adoption bypass                                                                                                                                                                                                                                |
| Exclusion changes after an install was prepared                                    | Stale selection authorization cannot install the excluded candidate                                                                                                                                                                                                                                    |
| Primary context never opens / stale or secondary ready arrives                     | No invented failed attempt; no unauthorized confirmation                                                                                                                                                                                                                                               |
| Secondary context requests candidate execution before primary startup              | Defer/reject opening or explicitly designate it primary; no candidate execution before the durable attempt                                                                                                                                                                                             |
| Primary ready arrives while a pre-confirm secondary is pending                     | Do not confirm until that page reaches one of the four terminal states or an accepted transition atomically writes terminal state `authorized-cancel`, exact reason `managedTransition`, and its transition ID                                                                                         |
| Corrupt archive/hash, configured signature failure, traversal or metadata mismatch | Reject before candidate execution; preserve the current release                                                                                                                                                                                                                                        |
| Same appVersion but different native compatibility identity                        | Reject before execution with an incompatibility result; avoid repeated download loops                                                                                                                                                                                                                  |
| Multi-page artifact presented to an older single-entry host identity               | Reject before execution; the old schema-version-1 reader cannot ignore page fields                                                                                                                                                                                                                     |
| Independently pinned Sparkling combination                                         | Record every iOS source, npm tarball/tag and Android Maven/source checksum; pass cross-provenance bridge, router, loader, lifecycle and device tests without asserting content equivalence                                                                                                             |
| Interrupted installation or concurrent requests                                    | No partial installation becomes active                                                                                                                                                                                                                                                                 |
| Multiple containers and in-flight resource requests                                | One process release; no mixed resources or premature cleanup                                                                                                                                                                                                                                           |
| `sparkling-navigation` main → detail                                               | The packaged router opens the exact allowlisted `detail.lynx.bundle`; main and detail have different context IDs and the same process, generation, Bundle, Release and verified installation                                                                                                           |
| Noncanonical path or unsafe navigate/open option                                   | Reject before upstream open or native stack mutation; only canonical ASCII page paths, push semantics and ownership-neutral animation are accepted                                                                                                                                                     |
| Route, query or stack bound exceeded                                               | Reject before upstream open, container creation or native/logical stack mutation; apply the 4,096-byte route, 32-custom-parameter, 128-byte key, 1,024-byte value, 2,048-byte decoded aggregate and 16-page limits identically on iOS and Android                                                      |
| Manifest page resource descriptors                                                 | Every page uses its exact manifest-covered `pageEssentialResources`; missing, extra, unsafe or unverified descriptors reject the complete artifact                                                                                                                                                     |
| Detail first load fails before primary confirmation                                | One durable generation/page failure prevents primary confirmation; OTA Release suppression and Bundle crash history apply, embedded identity is recorded without blacklisting, and the complete stack recovers or fails closed                                                                         |
| First detail load fails after Release confirmation                                 | An OTA Release becomes durably ineligible and its Bundle enters crash history; embedded failure is recorded without blacklisting; the complete generation retires and the ordered stack recovers or fails closed                                                                                       |
| Back/close while detail admission is pending                                       | Only the live native top or same top source cancels once; no Release suppression or Bundle crash history, and every late signal is stale                                                                                                                                                               |
| Managed transition while page admission is pending                                 | Transition acceptance and every source-generation terminal state `authorized-cancel` record with exact reason `managedTransition` commit atomically with one transition ID; retained pages receive fresh attempts after recreation                                                                     |
| Process death while detail admission is pending                                    | Before and after Release confirmation produce the specified durable interruption/suppression outcome, no false crash, one complete-stack recovery and no stale attempt resurrection                                                                                                                    |
| Full-page native navigation and recreation                                         | iOS uses real `SPKViewController` pages and Android uses packaged full-page Activity-equivalent Sparkling containers; route open, native back, close, ordered entries, params and top page remain correct across reload/recovery                                                                       |
| Native binary upgrade                                                              | Revalidate compatibility and binary-scoped state; use a safe fallback                                                                                                                                                                                                                                  |
| Native files resemble RN names or collide with reserved metadata                   | Preserve supported runtime files; reject metadata conflicts before upload                                                                                                                                                                                                                              |
| Archive → forward delta → reverse delta and rollback                               | Apply actual A-to-B and B-to-C patches, then actual C-to-B and B-to-A patches against each verified active base; retain required bases and verify every target manifest asset before activation                                                                                                        |
| No-archive mixed multi-page delta                                                  | Apply main BSDIFF plus a raw complete changed detail file under one authenticated target manifest; corrupt or missing detail rejects the whole target and leaves the running Release unchanged, including on required reverse vectors                                                                  |
| Corrupt/missing patch, changed file, or stale base                                 | Use an authorized verified fallback or reject safely; do not publish a partial target or change the running bytes                                                                                                                                                                                      |
| Standard Sparkling scaffold integration                                            | App native sources contain ordinary registration, configuration and mount wiring only; packaged integration supplies the real router/page stack, bridge, resources, lifecycle and update behavior                                                                                                      |
| Production native source boundary                                                  | Structural checks allow only normal Sparkling registration, immutable configuration, packaged-host construction, mount/reattach/close wiring; they reject application-owned update selection, artifact-path resolution, loaders, routers, recovery, restart/exit, crash classification and diagnostics |
| Engine-neutral build and fingerprint                                               | Opaque entries and explicit compression work without RN filename rules; native input changes alter the integration fingerprint; RN regressions stay green                                                                                                                                              |
| Pure OTA core and common CLI                                                       | Neutral production packages contain no RN, Expo, Hermes, Metro, `.hbc`, RN native-file inspection or engine-specific artifact policy; a Lynx-only fixture initializes, diagnoses, fingerprints, signs, deploys and verifies infrastructure through integration hooks                                   |
| Shared deployment with isolated projects                                           | RN and Lynx use identical platform/channel/version/fingerprint values on distinct routes and stores in one process; catalog, artifact, admin, API-key, rollback, insight and storage reads cannot cross project boundaries                                                                             |
| Default reload acceptance                                                          | Old-context Promise returns only durable `TRANSITION_ACCEPTED`; validation/persistence rejection leaves the old generation unchanged, and no old Promise reports reconstruction outcome                                                                                                                |
| Reset or forced activation                                                         | Reset scope mutation and transition acceptance are atomic; forced acceptance follows verified installation; rejection preserves the old generation and staged update/state as specified                                                                                                                |
| Immediate activation on both OSes                                                  | App remains in one OS process; all managed containers move together, and only matched new-generation content/readiness plus `UPDATE_APPLIED` or `RECOVERED` proves completion                                                                                                                          |
| Concurrent reload, stale callback, or failed reconstruction                        | Exactly one transition ID is accepted; competitors reject, stale callbacks cannot mutate it, and reconstruction recovery is reported durably from the new generation                                                                                                                                   |
| Runtime identity field type or lifecycle mismatch                                  | Reject numeric or noncanonical `processId`, missing identity keys, empty required strings, and invalid nulls; one OS process shares one process string, process replacement changes it, generation recreation changes `generationId`, and replay preserves original identities                         |
| Runtime event field reaches or exceeds its bound                                   | Accept an exact 128-byte name and exact 64-KiB serialized details; reject either field at one byte over without journal mutation                                                                                                                                                                       |
| Canonical runtime journal and public snapshot                                      | The same valid ordered input events produce byte-identical RFC 8785 persisted bytes on iOS and Android with only the defined envelope/event keys and inline details; persistence contains no oldest/latest aliases, and the public snapshot derives those strings without exposing `nextSequence`      |
| Valid runtime journal append crosses a retention bound                             | Accept the append after minimum oldest-first eviction, retain at most 256 events and 16 MiB, and atomically persist sticky `truncated=true`                                                                                                                                                            |
| Persisted runtime journal is corrupt or already oversized                          | Trust no old event or sequence; atomically repair to an empty `truncated=true` journal before future use, or keep the journal unavailable if durable repair fails                                                                                                                                      |

Let `S` be the ordered shared default scenario manifest. The shipped Lynx default
manifest is exactly `S` with only `metadata-v1-migration` removed, followed by
exactly one Lynx-specific scenario named `sparkling-multipage-ota`. It may not
omit or reorder another shared scenario, add another exclusion, or add an
unreviewed shortcut. The sole exclusion preserves the user's decision not to
migrate React Native legacy metadata; the RN manifest and its migration coverage
remain unchanged.

`sparkling-multipage-ota` runs the real two-entry E2E build through the shipped
`e2e:lynx` runner, the package-owned raw-input boundary, and the actual locked
public `sparkling-navigation.navigate()`, not a synthetic in-bundle screen stack
or native test route. It observes main and full-page detail on
embedded A, forward A-to-B and B-to-C activation, and reverse C-to-B and B-to-A
rollback. After every transition it verifies page marker, Bundle, Release,
process, generation, distinct contexts, ordered stack, params and top page; opens
and closes detail through both JavaScript close and native back; rejects stale
source navigation after replacement; and rejects embedded, staged-next,
cross-Release, network, or unmanaged-provider detail fallback. It also executes
the canonical-path and option rejection vectors, authoritative per-page resource
checks, pending-admission back/close cancellation and process-death cases before
and after confirmation, pending-page managed-transition cancellation, both detail
first-load failure timings, old-host identity
rejection, cross-provenance compatibility checks, and the no-archive mixed
multi-page delta failure vector defined above. For reload, reset and forced
activation it records old-context `TRANSITION_ACCEPTED`, then waits for actual
new-generation content/readiness and a launch receipt with the same transition
ID. When a page was pending, the acceptance evidence also contains its
`authorized-cancel` reason `managedTransition` and that transition ID; the
recreated page has a different attempt identity. Waiting for the old Promise
alone fails the scenario. Boundary vectors accept the exact route, query,
decoded-field, aggregate, stack and event-field maxima, then reject one byte,
parameter or page over those input limits without mutation. Journal retention is
tested separately: an exact 256-event or 16-MiB state is retained, and one more
valid append succeeds after minimum oldest-first eviction with
`truncated=true`. Corrupt and already-oversized persisted inputs expose no old
events and produce the durable repair or unavailable outcome above. The scenario
fails whenever the journal's sticky `truncated` flag is set and any required
evidence may have been evicted or cannot be proven complete. Given the same
ordered input vector, the nonproduction harness also compares the exact persisted
bytes across iOS and Android and verifies the defined public snapshot projection.
It rejects numeric `processId` explicitly, exercises every required string/null
combination, proves one process value across managed recreation, and proves a
different value after OS process replacement without coercing replayed
identities.

The required agent invocation is `hot-updater-agent verify -platform full -profile standalone-kysely -env-target examples/lynx/.env.hotupdater`. Both iOS
and Android children must execute the repository's shipped `e2e:lynx` runner,
use application ID `com.hotupdater.lynxexample`, load the manifest from the exact
checked-out commit, and report `sparkling-multipage-ota` in the executed default
scenario list. A different app ID, direct ad hoc runner, matrix-only application,
single-platform job, non-standalone-kysely profile, or synthetic receipt does not
satisfy this full-platform gate.

| Framework  | iOS: startup, bridge, navigation, OTA, recovery | Android: startup, bridge, navigation, OTA, recovery |
| ---------- | ----------------------------------------------- | --------------------------------------------------- |
| ReactLynx  | Unverified                                      | Unverified                                          |
| VueLynx    | Unverified                                      | Unverified                                          |
| OctaneLynx | Unverified                                      | Unverified                                          |

All six cells must pass before claiming the proposed support is complete.

Every cell uses the real ReactLynx, VueLynx, or OctaneLynx two-entry A/B/C
compiler output on its OS. Native events must prove that main and detail have
different context IDs but the same process, generation, Bundle, Release and
startup attempt where applicable. Each cell must navigate to detail after
embedded A, offline B activation and retention, forward C activation, and reverse
rollback. Evidence must include the exact main/detail hashes loaded from the
selected manifest, each page's verified essential-resource descriptor, and the
independently resolved Sparkling checksums. It must fail if detail came from
embedded A, a staged next selection, another installed Release, the network, or
an unmanaged Sparkling provider.

The six-cell receipt must additionally identify the concrete native page class,
ordered stack entries and parameters, top page, route source context, and
open/back/close results. It must retain those observations across immediate
reload and both recovery timings, including pending-admission cancellation and
process interruption. Any cell whose required evidence depends on a journal
marked `truncated` fails. A receipt that proves only two context IDs, uses a
split-screen duplicate main view, or does not exercise a real iOS
`SPKViewController` and Android full-page Activity-equivalent container fails the
cell.

## 8. Resolved design decisions

| Area                       | Implemented contract                                                                                                                                                                                                                                                                                                                                                                                         | Evidence still required                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Host                       | The optional Sparkling integration owns its managed router/page stack, bridge, resources, lifecycle, recovery, and all managed containers; the default Sparkling example uses that complete integration                                                                                                                                                                                                      | Final native build plus six current device cells                                                                                         |
| Compatibility              | Native supplies an exact runtime identity that includes the managed page/router/resource contract and independently pinned Sparkling provenance; check-time validation retains no preparation                                                                                                                                                                                                                | Current device mismatch, old-host rejection, cross-provenance and no-redownload evidence                                                 |
| Metadata                   | Manifest-covered schema-version-1 `hot-updater-lynx.json` binds Bundle, OS, main entry, deterministic `pageEntries`, authoritative `pageEssentialResources`, and runtime; the both-fields-absent compatibility form means one entry/resource                                                                                                                                                                 | Final two-page packaged archive and launch receipts                                                                                      |
| Resource addressing        | The managed router accepts only an exact verified running-release page entry; `hot-updater:///` resolves it and dependencies through context-scoped leases without next/embedded/network fallback                                                                                                                                                                                                            | Origin-off page navigation and in-flight retirement receipts                                                                             |
| Startup confirmation       | Durable primary attempt plus real first content, required resource success, and app readiness                                                                                                                                                                                                                                                                                                                | Current host recovery and stale-context device receipts                                                                                  |
| Secondary admission        | Every detail first load has one of exactly four terminal states; pre-confirm primary readiness waits for no pending secondary; top back/close and accepted managed transitions use distinct `authorized-cancel` reasons                                                                                                                                                                                      | Failure, interruption, cancellation, transition-ID and stale-signal evidence in the shipped E2E and six cells                            |
| Immediate activation       | Old-context Promise reports only durable transition acceptance; both OSes then replace every managed runtime/view in one foreground process, and new content/readiness plus the matched launch receipt proves completion                                                                                                                                                                                     | Acceptance/transition/process/generation/context identity receipts                                                                       |
| Navigation state           | Reload and recovery preserve at most 16 bottom-to-top logical entries, bounded forwarded string params and the top page in real full-page native containers; route/query/stack overflow rejects before upstream or native mutation                                                                                                                                                                           | Open/back/close, exact-boundary rejection and recreation receipts on both OSes                                                           |
| Runtime evidence           | Every event has canonical string/null runtime identities, including positive-decimal-string `processId`; the exact RFC 8785 envelope stores decimal-string `nextSequence` and inline events, while the public snapshot derives oldest/latest; field overflow rejects without mutation, retention overflow evicts oldest with sticky `truncated=true`, and corrupt persistence repairs or remains unavailable | Cross-platform identity-type/lifecycle, byte-identity, snapshot, field-boundary, retention, durable-repair and E2E completeness receipts |
| Unconfirmed exits          | Durable per-Release suppression remains separate from Bundle crash history                                                                                                                                                                                                                                                                                                                                   | Current B/C recovery device receipts                                                                                                     |
| Native reuse               | Lynx owns its native controller/installer; common delivery contracts stay engine-neutral                                                                                                                                                                                                                                                                                                                     | Mixed RN/Lynx regression and package checks                                                                                              |
| Core/CLI neutrality        | Common packages expose opaque OTA contracts and integration hooks; RN, Expo, Lynx, Hermes, Metro, Sparkling and native remediation policy stay in their integrations                                                                                                                                                                                                                                         | Remove remaining common CLI/config RN assumptions; pass source boundary, Lynx-only CLI and RN regression tests                           |
| Delivery-project isolation | One deployment may mount RN and Lynx as separate `createHotUpdater` instances with distinct route, database/schema, API keys and storage namespace; no engine column is added                                                                                                                                                                                                                                | Cross-project catalog/artifact/admin/key/rollback/insight/storage isolation test                                                         |
| CLI integration            | Build integrations declare setup, diagnostics, artifacts, portable names, compression, patch asset, fingerprint, signing authority and native remediation                                                                                                                                                                                                                                                    | Final workspace and real deployment validation                                                                                           |

## 9. Current implementation and remaining evidence

The PRD decision commit is `01bb61260b932e20d3e3f8a3e8e957369f887e17` on PR
#1300. The current pushed implementation is
`f54a3ae47`. It includes the engine-independent
runtime and build API, strict archive and delta installers, engine-neutral
delivery declarations, integration-owned React Native and Expo fingerprint
policy, packaged Sparkling hosts, the production example, and the framework
matrix harness.

The production example uses the basic Sparkling page architecture: main and
detail are separate compiler outputs, a button opens the detail route through
`sparkling-navigation`, and native resolves both pages from the same verified
Hot Updater selection. Immediate activation recreates every managed runtime and
restores the bounded logical page stack on both OSes. Application-owned iOS and
Android code is limited to ordinary library configuration, host registration,
and view attachment; update, recovery, resource, routing, and generation logic
lives in `@hot-updater/lynx`.

The public client has no `getManifest`, `getInstallId`, `addListener`, `setUser`,
or init-time insights surface. `init()` accepts transport configuration and an
error callback. Update bytes are prepared only through the update returned by
`checkForUpdate()`. A catalog acceptance revision race is retried up to three
times. `isUpdateDownloaded()` reads the authoritative native `nextSelection`.
Default reload reports durable transition acceptance to the old caller and its
completion through the replacement generation's durable receipt and readiness.
Custom reload requires an explicit handler.

Managed resource URLs carry the positive managed-runtime generation as an exact
query parameter. Android and iOS accept only that strict optional parameter and
resolve the underlying manifest path unchanged. This prevents process-scoped
Lynx resource caches from reusing an earlier generation's font or other managed
resource after immediate activation. Android recovery evidence associates every
redirected resource diagnostic with the matching confirmed JavaScript generation
in the current OS process; retained diagnostics from an earlier process cannot
satisfy the assertion.

The server limits serialized `ArtifactInfo` to 528,384 UTF-8 bytes, resolves
changed-file URLs with at most 16 concurrent operations, and selects a bounded
manifest representation or verified archive fallback. Artifact lookup may omit
corrupt optional patch rows; administrative Bundle hydration remains strict.
Archive construction, promotion, artifact ordering, and integration-owned
fingerprinting are deterministic and mutation-safe. Shared promotion assets and
superseded patch objects are retained until cleanup can prove ownership and the
absence of references atomically. The rollback scenario requires actual forward
A-to-B and B-to-C BSDIFF application and reverse C-to-B and B-to-A BSDIFF
application; archive fallback cannot satisfy those assertions.

Artifact packaging places React Native and Hermes policy in
`@hot-updater/react-native`, while Expo owns Expo fingerprint generation,
conflict detection, and generated-native-configuration guidance. The common
delivery path uses explicit artifact, compression, patch-entry, and fingerprint
contracts and does not infer a JavaScript engine from filenames. The common CLI
now discovers application integration descriptors instead of enumerating build
types. Integration descriptors own setup dependencies and generated build
configuration; build plugins own command validation and doctor checks. RN native
wiring inspection moved to `@hot-updater/react-native`, and signing remediation
uses integration-neutral language. The boundary test scans production source and
package descriptions across core, server, plugin-core, cli-tools, and the common
CLI, including infrastructure build scripts. It passed with the focused common
CLI suite at 521/521 and RN package suite at 146/146. The separate Lynx-only CLI
fixture remains required before release readiness can be claimed.

Historical SDK3 receipts demonstrate A-to-B operation across ReactLynx,
VueLynx, and OctaneLynx on both OSes. They do not establish the current equal
framework claim. VueLynx and OctaneLynx framework-generated `loadLazyBundle`
output remains an unresolved release blocker whenever supported production output
contains that path; verified core external JavaScript and native
dynamic-component paths are distinct capabilities and are not framework-lazy
evidence. See the dated
[evidence reconciliation](./evidence/reconciliation-2026-09-13.md).

Verification on the current implementation includes:

- `pnpm --filter @hot-updater/lynx test:type` and
  `pnpm --dir examples/lynx test:type`;
- Android Sparkling `testDebugUnitTest`, including managed-runtime replacement;
- `pnpm -w lint`;
- 429 E2E unit tests in 22 files, including page-stack back synchronization,
  delta evidence, crash recovery projection, and the explicit Lynx manifest;
- 17 focused Android crash projection and recovery tests; and
- green GitHub Integration on the pushed implementation commit.

Focused device validation through `ba25ecd98` includes Android
`force-update-auto-reload` in one process with a replaced managed generation and
new Bundle, Release, marker, and `UPDATE_APPLIED` receipt. Android
`bspatch-disabled-chain-rollback` also passes with actual forward and reverse
BSDIFF chains. Swift `LynxControllerLocalTests` pass 32/32.

Full job `job-20260921181047-umah90` ran with profile `standalone-kysely`,
`examples/lynx/.env.hotupdater`, application ID
`com.hotupdater.lynxexample`, and 26 scenarios per OS. It passed 51/52 on
`f54a3ae47`: iOS passed 26/26 and Android passed 25/26. The sole failure was the
final Android `sparkling-multipage-ota` generation. Its launch-wide log window
still included three already observed font diagnostics after the bounded native
journal had evicted an earlier page generation, so strict correlation rejected
the count. Commit `348284787` creates a new Android log checkpoint after every
successful managed-resource validation. This bounds subsequent checks to
unverified diagnostics without weakening native identity, ordering, font-load,
readiness, or fatal-boundary validation. Full job
`job-20260921233538-pspvrq` later reproduced the same final Android scenario with
an interleaved same-generation sibling-page boundary after journal truncation.
Commit `338c75c3a` makes the evaluator ignore only sibling-page identities whose
runtime, process, generation, attempt, Bundle, and Release provenance all match;
different-generation and different-provenance boundaries still reject. The
focused journal suite passes 49/49. A current full run has not yet verified that
fix, so the 51/52 result remains the best record and is not final acceptance.

## 10. Execution sequence and completion criteria

1. Reconcile the preserved worktree changes against this consolidated PRD. Keep
   prior verified fixes; finish incomplete delta code and remove obsolete tests
   that assert the presence of incorrect source strings. Tests must establish
   behavior, including negative cases.
2. Finish neutral manifest/build/fingerprint ownership and server consumption.
   Validate opaque non-`.bundle` patch entries, explicit raw/Brotli representation,
   deterministic ASCII `pageEntries`, authoritative `pageEssentialResources`,
   the schema-version-1 both-fields-absent compatibility form, preservation of
   the common Unicode artifact collision namespace, older RN archive
   compatibility, and managed-page native identity sensitivity.
3. Complete both native delta installers with strict trust, base ownership,
   cancellation, crash durability, and later-launch verification. Exercise real
   patch bytes, malformed input, fallback, stale/concurrent preparations, and the
   no-archive main-BSDIFF/detail-raw vector with corrupt-detail atomic rejection
   in both forward and required reverse directions.
4. Package the Sparkling host integration, managed router, and native page stack,
   and replace application-owned native implementation with ordinary registration,
   configuration, and mount wiring. Implement logical-page generation recreation
   and verify real `sparkling-navigation`, bridge initialization, all managed
   resource loaders, secondary admission, both first-load failure timings,
   pending close/back and managed-transition cancellation, process interruption,
   real full-page
   platform containers, canonical raw paths, route option/source authority,
   stale-signal teardown, durable transition acceptance before caller teardown,
   reset/forced/concurrent rejection behavior, matched new-generation completion,
   and ordered stack/parameter/top reconstruction on both OSes. Lock each
   Sparkling component to its independently reviewed provenance,
   record checksums, and prove the resulting cross-provenance combination.
5. Use an explicit Lynx default manifest equal to the shared default minus only
   `metadata-v1-migration`, plus the required Lynx multi-page navigation scenario.
   Configure the agent's Lynx target to read that manifest from the checked-out
   PR commit. Preserve every remaining shared scenario's actual semantics,
   including delta and artifact selection, and prove actual main/detail navigation
   through forward activation and reverse rollback.
6. Run build, types, lint, unit/native tests and relevant shared integration
   regressions. Commit the required implementation paths and update PR #1300;
   preserve the six staged-only local helpers. Obtain green Integration on the
   exact pushed implementation.
7. Run `hot-updater-agent verify -platform full -profile standalone-kysely -env-target examples/lynx/.env.hotupdater` from the execution worktree. Require
   both platform children to use the shipped `e2e:lynx` runner, application ID
   `com.hotupdater.lynxexample`, the exact checked-out manifest, and the complete
   default list including `sparkling-multipage-ota`. Require a successful job,
   correct Lynx routing/app identity, and all applicable scenarios passing.
   Inspect child stage logs rather than relying on a generic failure
   classification. Fix concrete failures and repeat.
8. Complete the six-cell device acceptance matrix on unchanged native release
   binaries, including origin-unavailable startup, resources, retention,
   readiness/recovery, real main/detail navigation, forward and reverse delta,
   and logical-page generation replacement. The default agent
   ReactLynx run does not replace VueLynx/OctaneLynx evidence.
9. Reconcile the final implementation against the existing multi-agent
   adversarial review, resolve actionable findings, and update English
   documentation and the PR around the verified result. Perform the remaining
   work directly in this task without subagents. Report unsupported upstream
   categories explicitly. Mark the goal complete only when every required gate
   is met.

Each result must identify the source commit, native binary/runtime identity,
framework, platform, command, and retained evidence. An aggregate test count,
current README claim, dry run, CI success, or guessed native state cannot replace
an absent acceptance result.
