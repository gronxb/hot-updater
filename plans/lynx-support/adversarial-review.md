# Lynx PRD: adversarial review record

Date: 2026-09-11

**Review outcome: conditional agreement on a revised proposal.**

This record describes the review before implementation authorization. The user
subsequently approved PRD execution on 2026-09-11. Native feasibility was
unproven at the time of this review. Current implementation state is in the [execution ledger](./execution.md).

## Review provenance

The first PRD contained a single-agent examination of opposing viewpoints. That
was not an independent adversarial review. After the user explicitly requested
subagents, the following three agents performed separate read-only reviews:

| Agent | Assigned position |
| --- | --- |
| `/root/lynx_design_proposal` | Defend and refine the smallest framework-independent design; challenge unnecessary abstractions and unsupported reuse claims |
| `/root/lynx_native_adversary` | Challenge native execution, resource loading, bridge feasibility, startup confirmation and recovery |
| `/root/lynx_delivery_adversary` | Challenge CLI/archive integration, catalog compatibility, metadata trust and Release/Bundle semantics |

The primary agent inspected repository contracts, relayed findings between the
reviewers, and edited the planning documents. Reviewers were instructed not to
modify files, install dependencies, build, run tests or spawn further agents.

The review had three steps:

1. Separate first-round investigation using current repository code and pinned
   upstream sources.
2. Cross-examination of the other reviewers' objections against a common set of
   proposed decisions.
3. A targeted rebuttal of the unconfirmed-startup retry design, followed by an
   explicit revision from the original proposer.

This record summarizes the actual reports and exchanges. It is not a verbatim
transcript, and agreement is not evidence that native execution works.

## Round 1: objections that changed the proposal

All severity labels below concern risks in the proposed design. Source-confirmed
behavior is distinguished from an inferred failure scenario; no Lynx device
failure was reproduced during this review.

| Finding | Reviewer and evidence | Required change |
| --- | --- | --- |
| P1: RN archive rules violate opaque artifact preservation | Design and delivery independently identified `.map` removal and `.bundle.hbc` replacement/renaming in `packages/hot-updater/src/utils/getBundleZipTargets.ts:27-60` | Separate artifact handling; validate the final CLI archive, including names and bytes |
| P1: A prebuilt root manifest can be overwritten and duplicated | Delivery traced input hashing in `packages/hot-updater/src/commands/deploy.ts:968-1005` and overwriting in `packages/hot-updater/src/utils/bundleManifest.ts:27-29` | Reserve Hot Updater metadata paths and reject collisions before hashing/upload |
| P1: OS/appVersion does not establish native ABI compatibility | Delivery checked `packages/core/src/releaseCatalogScope.ts:173-197` and `plugins/plugin-core/src/releaseCatalogCompiler.ts:727-737`; design agreed | Add native-owned, manifest-bound compatibility admission with explicit limits |
| P1: File-tree preservation does not imply offline resource resolution | Native traced separate Sparkling loaders and Octane/Vue asset prefixes; delivery independently identified prebuilt URL assumptions | Require a supported release resource-addressing and cache contract |
| P1: Plain JS imports do not establish valid native calls | Design checked Lynx background-only modules; native checked Octane's two execution graphs and unverified native paths | Safe imports, background calls, actual module/error/ready round trips in all six combinations |
| P1: Ready, first content, fatal failure and unexplained exit were conflated | Native traced distinct OS startup/error observations; design challenged early-close and stale-context cases | Define native-attributed confirmation and separate failure outcomes |
| P1: Cold start and multiple containers lacked one selection scope | Native traced container-specific identity and late callback risks | One selected release per process and one designated startup context |
| P2: RN entry discovery and cleanup cannot be reused unchanged | Design and delivery checked RN-specific entry assumptions and native storage cleanup | Explicit entry selection; retain files used by active contexts and requests |
| P2: Compiler, Bundle, Release and embedded identities were blurred | Delivery traced minimum-ID filtering and native identity ownership | Fresh Bundle identity at packaging, separate Release authorization, native-owned embedded/minimum identity |

The design reviewer defended retaining the BuildPlugin integration and a thin
Lynx/native boundary. The delivery reviewer objected to promising that the exact
interface would remain unchanged: the current return shape does not itself tell
the CLI which artifact transformations to apply. The revised PRD keeps reuse as
the direction and requires an explicit handling boundary before API freeze.

## Round 2: cross-examination and dispositions

### Compatibility and delivery selection

All reviewers accepted native-owned compatibility checking as necessary. They
rejected the claim that separate infrastructure and semver targeting provide it.

The design reviewer allowed a manually maintained compatibility identity as an
initial mechanism. The delivery reviewer qualified that acceptance: equality
proves only agreement on a declared contract, not that a producer labeled every
ABI dependency correctly. The native reviewer required the check before any
candidate evaluation. The PRD therefore requires native ownership, artifact
provenance, invalidating inputs and pinned device evidence, with exact matching
and rejection of absent/unsupported metadata.

Delivery also challenged a zero-server-change promise. Existing opaque artifact
resolution makes a client-side check plausible, but the newest incompatible
candidate can still win server selection. The PRD now treats mismatch as a
terminal result for that check, preserves launch state, requires rejection-cache
invalidation to be designed, and does not claim automatic selection of an older
compatible release or guarantee that no schema change will be needed.

### Prebuilt resources and SDK-free readiness

All reviewers accepted prebuilt input only when it satisfies the supported native
compatibility and host resource-addressing contracts. A host may map existing
URL schemes; the contract does not require bundle-relative addressing or allow
binary rewriting. Release-owned misses cannot silently use embedded/network
substitutes. Ordinary network application data is a separate concern.

Native challenged SDK-free readiness: loading or displaying initial content
alone can miss background startup failure. Design accepted host-managed readiness
only if it establishes the same native observation and successful essential
startup as an app signal. The PRD distinguishes packageable files from confirmed
OTA operation.

### Feasibility before API stabilization

The three reviewers agreed that the original artifact-first milestone order
would leave the highest-risk assumptions untested. The revised G1 demonstrates
native entry/resource loading, module/error transport and startup attribution
before the new public API is frozen. Internal adapters and manual placement are
valid spike tools; they do not require a completed OTA engine and cannot count
as end-to-end OTA success.

All six target combinations remain required. Missing Octane reload support alone
does not disqualify process-restart OTA, but missing native startup/bridge evidence
cannot be replaced with compiler success or web preview.

### Process and attempt identity

All reviewers accepted one process-wide release and a host-designated primary
startup context as the initial policy. The design reviewer clarified that an
attempt begins immediately before candidate evaluation, not simply when the
native process starts. A process that never opens Lynx must not fabricate a failed
startup. Native binds readiness to a live authorized context and current attempt;
untrusted IDs supplied by JavaScript are insufficient.

During the final document check, both the design and native reviewers identified
an ordering gap: a secondary context could otherwise evaluate B before the
primary had recorded an attempt. The PRD now requires primary designation and a
durable attempt before any context evaluates candidate code. An earlier secondary
request waits, fails to open, or is explicitly designated primary. The acceptance
table includes this case. The delivery reviewer found no remaining contradiction
in the artifact, identity, selection and retry qualifications it reviewed.

## Targeted rebuttal: one unresolved receipt is insufficient

The native reviewer proposed a conservative rule: an unexplained exit before
readiness falls back and blocks automatic restaging of the same Release ID,
without adding its bundle to crash history. A new authorized Release ID may retry
the same bytes. The first version suggested one unresolved-attempt receipt was
sufficient.

The delivery reviewer provided this counterexample, based on candidate scanning
in `packages/core/src/releaseCatalog.ts:204-220`:

1. B exits before readiness and is suppressed.
2. Newly authorized C also exits before readiness.
3. C replaces the only receipt, losing B's exclusion.
4. Selection skips C but can choose B again.

The native reviewer explicitly accepted the counterexample and withdrew the
single-receipt proposal. The design reviewer also accepted the corrected policy.
The resulting shared requirements are:

- Preserve per-Release unconfirmed exclusions across later attempts within the
  native binary/scope.
- Apply exclusions to all automatic activation/rollback paths and invalidate
  stale selection context or prepared install authorization.
- Do not clear exclusions on unrelated catalog generations, ordinary restarts,
  or storage compaction that would make an excluded release eligible again.
- A newly authorized Release ID may reuse cached bytes, but it starts a fresh
  unverified attempt and cannot inherit readiness or bypass verification through
  metadata-only adoption.
- Keep existing metadata-only adoption semantics for already confirmed running
  bytes; do not force unnecessary re-downloads.

The conservative product tradeoff is explicit: a healthy update interrupted by
the user before confirmation may fall back and remain held until a new Release
authorization. No new manual-retry API is proposed initially. Storage and safe
capacity handling must be resolved in G1; no reviewer claimed a device-tested
implementation of this behavior.

## Result and remaining uncertainty

The reviewers conditionally agree on the revised safety and scope requirements.
Their objections produced changes in PRD sections 4–8, especially compatibility,
resource resolution, readiness, retry exclusions, and milestone order.

The following remain unproven:

- Actual native startup, bridge and managed-resource behavior for every supported
  framework/OS/toolchain combination, particularly Octane.
- Concrete Sparkling loader/cache hooks and reliable startup observations.
- Compatibility identity derivation/provenance and the versioned metadata schema.
- The smallest explicit CLI artifact-handling change that preserves RN behavior.
- Native reuse boundaries, exclusion retention, stale-authorization invalidation,
  compatibility rejection caching and binary-upgrade state handling.

These are G1/G2 work items after user review, not silently resolved findings.
The review approves neither the existing experimental implementation nor
publication of a Lynx support claim.

## Source anchors

- Sparkling commit: `c4ce8d25c5ea277e13752d68ff1f2a66f5704240`.
  [iOS view integration](https://github.com/tiktok/sparkling/blob/c4ce8d25c5ea277e13752d68ff1f2a66f5704240/packages/sparkling-sdk/ios/Sparkling/Sources/Service/LynxService/SPKWrapperLynxView.swift)
  and [Android lifecycle callbacks](https://github.com/tiktok/sparkling/blob/c4ce8d25c5ea277e13752d68ff1f2a66f5704240/packages/sparkling-sdk/android/sparkling/src/main/java/com/tiktok/sparkling/hybridkit/lynx/SimpleLynxViewClient.kt).
- VueLynx commit: `4e75e3ef1efc17a239adaa48a665ef699a6423f5`.
  [Example configuration](https://github.com/Huxpro/vue-lynx/blob/4e75e3ef1efc17a239adaa48a665ef699a6423f5/examples/hello-world/lynx.config.ts).
- Octane commit: `c31f629185f7d768c821557f6fb49dc46daf671c`.
  [Native status evidence](https://github.com/octanejs/octane/blob/c31f629185f7d768c821557f6fb49dc46daf671c/packages/lynx/status.json)
  and [resource-prefix configuration](https://github.com/octanejs/octane/blob/c31f629185f7d768c821557f6fb49dc46daf671c/packages/rspeedy-plugin-octane/examples/gallery/lynx.config.mjs).
- [Lynx Native Modules](https://lynxjs.org/guide/use-native-modules.html)
  and [Octane's published Lynx status](https://octanejs.dev/docs/lynx), checked
  during the review on 2026-09-11.
- Repository native references: iOS
  `packages/react-native/ios/HotUpdater/Internal/BundleFileStorageService.swift:1652-1685,2050-2076,2922-2954`
  and `packages/react-native/ios/HotUpdater/Internal/HotUpdaterImpl.swift:559-565`;
  selector/context logic in `packages/core/src/releaseCatalog.ts:117-133,175-220`;
  artifact resolution in `packages/server/src/db/releaseCatalog.ts:122-146`.

## Implementation follow-up: resource scope

After the native probes, `/root/lynx_design_proposal` independently examined
whether core external background JavaScript can replace a failing
framework-generated async template. The review accepted app-owned compilation
and the real core `requireModuleAsync` path under PRD section 5.2. It rejected
counting that result as proof of generated async native templates or native
dynamic-component semantics.

The implementation therefore keeps three distinct evidence categories: core
external JavaScript, generated async native templates, and native dynamic
components. VueLynx and OctaneLynx's tested generated templates require an absent
`lynx.loadLazyBundle` helper. Their failure is preserved, including the embedded
baseline. This limitation does not authorize removing either framework or the
remaining resource acceptance requirements. Work can continue on the valid
engine integration while that obligation remains open.

## Implementation follow-up: native artifact installers

The reviewers performed independent cross-platform source reviews after the
first native installer tests: the native adversary reviewed Android, and the
delivery adversary reviewed iOS. These reviews were read-only; their failure
scenarios are source-derived unless a later evidence entry records reproduction.

| Finding | Reviewer | Required correction |
| --- | --- | --- |
| P1: Tiny malformed PAX headers can create an invalid Swift range or overflow record-end arithmetic | Delivery adversary | Checked arithmetic and bounds, thrown rejection, reproducing strict-TAR tests |
| P1: A compressed oversized manifest/sidecar can exhaust memory before JSON rejection | Delivery adversary | Metadata-specific size limits checked before allocation and during extraction |
| P2: ZIP entry/path limits run after central-directory strings have been allocated | Delivery adversary | Apply count/name limits while reading descriptors |
| P2: Coroutine cancellation can discard the Android preparation token outside its cleanup scope; blocking OkHttp is not promptly canceled | Native adversary | Outer transaction ownership, actual Job cancellation, OkHttp cancellation wiring and regressions |
| Empty Android native entry lacks a nonempty admission check | Primary agent | Reject an authenticated zero-byte entry before native evaluation |
| iOS manifest/sidecar JSON should reject conflicting duplicate keys consistently with Android | Primary agent | Bounded strict JSON validation before typed decoding |

The reviews found no other concrete bypass in verification-before-extraction,
nullable-manifest archive anchoring, configured signing, metadata/file binding,
immutable publication or the host finalization callback. This is a bounded review
result, not proof of a finished controller. Durable selection, retention,
resource leases and startup authority remain separate integration obligations.

Fix status and executed reproductions belong in the platform evidence and
execution ledger. The original RN native implementation remains unchanged; the
Lynx adaptations retain source provenance and record their stricter behavior.

## Implementation follow-up: public native controllers

The same two subagents independently reviewed the opposite platform's public
controller, journal, module and resource lifecycle. Owners were implementing
these components concurrently; the reviews distinguish concrete source defects
from acknowledged unfinished acceptance work.

| Finding | Required correction and evidence |
| --- | --- |
| Android `AtomicFile.finishWrite` can log a sync/rename failure without throwing, while the controller publishes success in memory | Use checked native write/sync/rename operations; exercise actual filesystem failures before claiming durable-before-evaluation |
| Android queues failure latching behind a ready callback; iOS initially latched fatal state only after a journal write | Invalidate readiness synchronously when native observes failure, even if persistence fails; reproduce callback ordering and I/O failure |
| Android startup verifies the archive but can lose its binding to a separately modified payload manifest when the transport manifest token is null | Persist the installer-produced manifest digest in native state and enforce it during restored-tree verification |
| Cohort included in the durable journal namespace clears exclusion/high-water history when cohort changes | Keep cohort in selection context; preserve history within the same native binary/runtime/channel and test a cohort change after unknown termination |
| Explicit EMBEDDED Release attempts bypass history/capacity rules because they use native embedded bytes | Distinguish Release authorization from BUILTIN identity; retain explicit Release outcomes and reserve capacity before evaluation |
| iOS same-byte adoption can re-enter startup confirmation with no pending attempt | Make confirmed readiness/resource observations idempotent while preserving immutable running bytes |
| iOS secondary/stale readiness validation drains primary callbacks or leaves observer-triggered failures unanswered | Isolate each caller's callback and complete or reject queued primary callbacks on confirmation persistence failure |
| Android's missing-file sentinel is producer-controllable; iOS's unsupported local/asset URLs can reach embedded fallback | Use an impossible managed miss and reject unsupported local addressing; preserve explicitly unmanaged host HTTP resources |
| Android admission counts retained tokens but not concurrent preparations | Reserve bounded capacity before starting asynchronous preparation and release it on every completion/cancellation path |

The owners are applying fixes, and reviewers are re-inspecting each correction.
Storage-fault, callback-race, payload-tamper, cohort-change, capacity and resource
lifetime runs remain separate evidence requirements. No reviewer treated source
inspection or aggregate unit counts as completed native OTA acceptance.

Policy reconciliation also found that the shared core permits a rollback
predecessor outside a new rollout's cohort. Both native helpers retain private
authorization provenance from their own selector, bound to the exact target and
prior selection. Stored eligibility still enforces the latest accepted scope,
high-water, membership, exclusions, minimum and crash rules. Forty-eight
core-generated fixture rows cover 24 scenarios per OS, including the cohort
exception and its inability to bypass a Release exclusion.

The first Android public check exposed an actual runtime capability gap in
channel encoding: `String.prototype.normalize` is absent. The chosen correction
adds native-owned canonical `channelKey` to the internal snapshot. Native already
validates NFC and performs UTF-8/base64url encoding; JS uses that key for the route
and expected scope. This preserves Unicode semantics without weakening shared
core validation or installing a global shim. The bridge requirement advances
the declared native compatibility profiles to `ota-v2`; new SDK3 fixtures retain
the failed SDK1/SDK2 evidence rather than overwriting it.
