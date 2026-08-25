# Release Catalog architecture plan

## Status and delivery boundary

- Baseline: [#1141](https://github.com/gronxb/hot-updater/pull/1141),
  `38d899088aa1f621dbc5f13e798f40cd489e85e5`
- Delivery unit: one large pull request based on #1141
- Target: HotUpdater 1.0
- Canonical state: database
- Read acceleration: CDN
- Write-time projection: AoT-compiled Release catalog in the same database

This document is the implementation plan and acceptance contract for that one
pull request. The numbered implementation sequence is not a PR split.

### Rollback semantics amendment (2026-08-18)

The following rules supersede any older forward-rollback or explicit
`EMBEDDED` wording that remains in historical planning notes:

- A Release ID is a canonical lowercase UUIDv7. Its lexical order is release
  chronology.
- Rollback does not insert a Release. It disables the current Release in the
  existing Release/catalog CAS transaction and retains its ID and provenance.
- Selection preserves v0 behavior: prefer a newer cohort-eligible Release;
  otherwise keep an eligible current Release; otherwise select the newest
  compatible enabled Release below the active Release while ignoring rollout
  and target cohorts; if none exists, select local `BUILTIN`.
- A lower Release or `BUILTIN` transition from OTA is a forced `ROLLBACK`.
  Already being on `BUILTIN` is a no-op, and same-Bundle Release adoption does
  not reload.
- Product APIs, CLI, Console, and compiler output do not create or expose
  explicit `EMBEDDED`/`ROLLBACK` Releases. Those schema values remain readable
  only for pre-1.0 development-data compatibility.
- The newer-update/crash frontier remains bounded to 11 Bundle artifacts. Exact
  predecessor selection for arbitrarily old active devices requires the full
  compatible enabled rollback spine, so that portion is O(history). It is never
  truncated: a catalog above 256 KiB rejects the mutation atomically.
- Console has no separate rollback dialog. Disabling `Enabled` explains that
  devices select the previous compatible enabled Release or `BUILTIN`.

## Why this change exists

The #1141 update-check URL contains `minBundleId`, current `bundleId`, and
`cohort`:

```text

```

These are installation-specific decision inputs. Two devices in the same
Release scope therefore use different cache keys, so a burst can execute the
runtime and `getUpdateInfo` database work almost once per request. Moving that
query between SQL, Firestore, DynamoDB, D1, and application code changes the
cost location but not the scaling shape.

The objective is:

> Make routine update checks share one response per authority, platform,
> channel, and app-version/fingerprint scope, so shared-cache providers grow at
> the CDN boundary and origin-only providers avoid the database decision path.

The architectural change is deliberately narrow:

1. The database remains the source of truth.
2. Immutable Bundle artifacts stay in Storage.
3. Mutable delivery intent becomes a Release row.
4. Release mutations AoT-compile a bounded catalog into the database.
5. A cold GET performs one exact catalog-row read.
6. The app evaluates install-dependent cohort, minimum floor, current state,
   and crash history locally.
7. Artifact resolution runs only when the selected Bundle bytes differ.

This avoids both failure modes discussed before this plan: the current
per-install database hot path and a new database/Storage dual-write boundary
that treats object Storage like Redis.

## Success criteria

The pull request is complete only when all of the following are true:

- A Release Catalog URL contains no current Release ID, current Bundle ID, minimum
  Release ID, install ID, cohort, or crash history.
- A cold origin GET reads one compiled catalog row by an exact derivable key;
  it does not scan Releases or Bundles and does not look up a channel first.
- Measured warm hits perform zero database reads and zero decision-origin work.
  Edge-shell executions, if a provider cannot avoid them, are reported
  separately and are never mislabeled as zero runtime invocations.
- On shared-cache providers, origin work is proportional to CDN fills per POP
  and TTL, not installations. Supabase origin-only Edge invocations remain
  proportional to checks, but they serve compiled catalogs instead of running
  per-install database decisions.
- Release mutation and catalog projection commit atomically using Release
  revision and catalog-generation CAS.
- Compiler failure, conflict, or oversize output leaves canonical Releases and
  the prior catalog unchanged.
- An accepted stale response cannot overwrite a newer decision, including when
  its artifact download finishes later.
- Deploy, rollout, target cohorts, force update, disable, rollback, promote,
  channels, runtime channel switching, patches, manifests, signing, crash
  recovery, analytics, authentication, and custom HTTP adapters have an
  explicit preserved or intentionally changed behavior in this document.
- All 14 existing Detox scenarios are migrated to Release semantics and remain
  meaningful on both iOS and Android.
- The controlled RED-to-GREEN provider stress regression passes on AWS,
  Cloudflare, and Firebase. The supported Supabase origin-only profile reports
  Edge Function invocations and Postgres reads separately without claiming
  shared-CDN hits.

## Non-goals

- Removing the database from HotUpdater.
- Writing one manifest for every device, app version, current Bundle, or
  cohort.
- Materializing policy in S3, R2, Firebase Storage, or Supabase Storage.
- Requiring Redis.
- Adding pagination to the device catalog protocol.
- Inventing a binary protocol. The first wire format is canonical JSON with
  ordinary HTTP Brotli/gzip compression.
- Moving selector policy into native Storage code. Native persists and
  crash-recovers selections; JavaScript owns policy evaluation.
- Claiming that every history fits one catalog. The full rollback spine is
  limited by the explicit 256 KiB atomic catalog ceiling.

## Domain model and changed mental model

### Bundle is immutable artifact identity

A Bundle answers only: “what bytes can be installed?”

```ts
interface Bundle {
  id: string; // UUIDv7 artifact identity
  platform: "ios" | "android";
  fileHash: string;
  storageUri: string;
  archiveByteSize: number;
  gitCommitHash: string | null;
  metadata: BundleMetadata;
  manifestStorageUri: string | null;
  manifestFileHash: string | null;
  assetBaseStorageUri: string | null;
  patches: readonly BundlePatchArtifact[];
}
```

The following move from Bundle to Release:

- channel
- enabled
- force update
- message
- app-version/fingerprint target
- numeric rollout
- target cohorts

Bundle identity continues to own archives, manifests, changed assets, signing,
patch lineage, local files, and crash history. `manifest.json` stays
Bundle-only and never receives a Release ID. Reusing a Bundle through promote
or rollback must not rewrite or re-upload its manifest.

`archiveByteSize` and every patch artifact's `byteSize` are required immutable
non-negative safe integers. Manifest asset entries may additionally carry an
optional `downloadByteSize` and `downloadFileHash`. The size describes the
exact representation served to the client; when that representation differs
from the logical file, such as a Brotli payload, the download hash is the
SHA-256 of those exact served bytes and owns the content-addressed object key.
The logical `fileHash` continues to identify and verify the installed file.

### Release is mutable delivery policy

A Release answers: “who should converge to which artifact?”

```ts
type ReleaseKind = "BUNDLE" | "EMBEDDED"; // EMBEDDED is legacy-read only
type ReleaseStrategy = "APP_VERSION" | "FINGERPRINT";
type ReleaseOperation = "DEPLOY" | "PROMOTE" | "ROLLBACK"; // ROLLBACK is legacy-read only

interface Release {
  id: string; // canonical lowercase UUIDv7
  revision: number;
  channelId: string;
  platform: "ios" | "android";
  kind: ReleaseKind;
  bundleId: string | null;
  strategy: ReleaseStrategy;
  targetAppVersion: string | null;
  fingerprintHash: string | null;
  enabled: boolean;
  shouldForceUpdate: boolean;
  message: string | null;
  rolloutCohortCount: number; // 0..1000
  targetCohorts: readonly string[];
  operation: ReleaseOperation;
  sourceReleaseId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}
```

Invariants:

- Newly authored Releases are `BUNDLE` and require a same-platform Bundle.
  `EMBEDDED` and `ROLLBACK` remain parser/schema compatibility values only.
- Exactly one compatibility strategy target is present.
- Release identity, Bundle reference, kind, and platform are immutable.
- Message, enabled, force, compatibility target, rollout, and target cohorts
  mutate the same Release and increment `revision`.
- Numeric rollout hashes the stable Release ID, not Bundle ID.
- Deploy and promote create a new Release. Rollback disables an existing
  Release and increments its revision.
- New IDs use a monotonic UUIDv7 allocator constrained to be lexically greater
  than the latest Release in every affected scope. Random UUIDv7 generation
  alone is not strictly ordered for same-millisecond writes; a CAS retry
  regenerates against the new floor.

### Rollback follows Release chronology

Release order authorizes movement. Disabling an active Release reveals the
newest compatible enabled Release below it; when none exists, the device uses
the local built-in bytes. The selected predecessor deliberately ignores rollout
and target cohorts, matching v0. A newer eligible Release still wins first.

`releaseId` controls policy chronology, rollout seed, and audit intent.
`bundleId` controls bytes, patches, manifests, signing, and crash identity.
They must never be conflated.

### BUILTIN is local fallback

New catalogs persist two desired-state kinds:

```ts
type SelectionKind = "BUNDLE" | "BUILTIN";
```

- `BUNDLE`: a real Release references an OTA Bundle.
- `BUILTIN`: a local fallback with `releaseId=null`, authorized only by an
  authenticated complete catalog's explicit fallback policy.

Native and schema readers may accept `EMBEDDED` receipts/rows created by
pre-1.0 development builds, but new compilers and management paths do not emit
them.

An always-materialized baseline Release is rejected because the server does
not know each native binary's built-in Bundle identity or floor, and because
it would incorrectly apply a first switch into an empty target channel.

## Database schema

### `bundles`

The final table contains only immutable artifact data. `bundle_patches` remains
keyed by target and base Bundle IDs.

`bundles.archive_byte_size` and `bundle_patches.byte_size` are required
and constrained to non-negative JavaScript safe integers. Providers must
reject missing, fractional, negative, or out-of-range values during row
hydration. These fields are part of the initial unreleased `1.0.0` schema, not
nullable compatibility metadata.

### `releases`

```text
id PK
revision
channel_id FK -> channels.id
platform
kind
bundle_id nullable FK -> bundles.id
strategy
target_app_version nullable
fingerprint_hash nullable
enabled
should_force_update
message nullable
rollout_cohort_count
target_cohorts JSON
operation
source_release_id nullable FK -> releases.id ON DELETE SET NULL
created_at_ms
updated_at_ms
```

Required access paths include channel/platform/Release-order paging, Bundle
references, fingerprint target, enabled state, and exact Release ID. Canonical
scope reads must come from a strongly consistent base-table access path, not an
eventually consistent secondary index.

### Canonical channel and scope identity

The URL and database point-read key must be derivable without a Channel table
lookup. Management operations therefore assign each exact stored channel name
a canonical path key:

```text
channelKey = base64url(UTF-8(NFC(channelName)))
```

Channel creation trims and NFC-normalizes once, rejects a non-canonical name,
and enforces uniqueness on the normalized value. The device encodes its
configured channel with the same shared helper. The server decodes once and
rejects alternate/non-canonical encodings.

Catalog scope keys are:

```text
v1:app-version:<authorityId>:<platform>:<channelKey>
v1:fingerprint:<authorityId>:<platform>:<channelKey>:<fingerprintHash>
```

`authorityId` is a stable project/server identity owned by deployment
configuration and embedded in the Catalog. React Native does not configure or
send it. Two servers that both call a channel `production` must return distinct
authorities so they never share generation high-water. There is no separately
issued dynamic `runtimeKey`. The complete catalog identity combines authority,
strategy, platform, channel key, and app version or fingerprint.

Channel deletion does not delete its catalog identity. An empty tombstone row
retains generation so delete/recreate or disaster repair cannot restart at 1.
Only an isolation-key migration may discard a device's corresponding
high-water map.

### `release_catalogs`

```text
scope_key PK
authority_id
strategy
channel_id
channel_key
platform
fingerprint_hash nullable
generation
payload
catalog_hash
byte_size
is_tombstone
updated_at_ms
```

The row is a deterministic, rebuildable projection, not canonical business
state. `generation` is a strictly increasing JSON-safe integer scoped to the
row. It is represented as TypeScript `number`, Swift `Int64`, and Kotlin
`Long`, checked at `Number.MAX_SAFE_INTEGER`, and never wraps. The hash is
SHA-256 of canonical compiler output and is not the app-version-specific HTTP
ETag.

Every accepted logical Release mutation increments all affected generations,
even if filtered bytes happen to be identical. A no-op verification rebuild
preserves generation. Removing the last eligible Release writes an empty
catalog with a newer generation; it never removes the row.

### Analytics rows

Launch and transition rows add nullable directional identities:

```text
from_release_id nullable
to_release_id nullable
from_bundle_id nullable
to_bundle_id nullable
```

Old events remain valid with null Release IDs. The server never guesses an
exact Release from Bundle ID.

## DatabasePlugin contract after #1141

### `queries` disappears completely

```ts
interface DatabasePlugin {
  readonly name: string;
  readonly models: DatabaseModels;
  commit(input: DatabaseCommit): Promise<DatabaseCommitResult>;
  dispose?: () => Promise<void>;
}
```

Delete:

- `DatabaseQueries`
- `DatabasePlugin.queries`
- `BundleRepository.queries`
- `DatabasePluginImplementation.getUpdateInfo`
- `createDatabasePluginAdapter(...).queries`
- `DatabaseClient.getUpdateInfo`
- provider SQL/RPC/DynamoDB/Firestore/Mongo/Prisma decision queries
- Postgres `get_update_info_by_app_version` and
  `get_update_info_by_fingerprint_hash`

Provider plugins expose storage models and atomic commit, never desired-state
policy.

### Model surface

```ts
interface DatabaseModels {
  readonly bundles: BundleModel;
  readonly bundlePatches: BundlePatchModel;
  readonly releases: ReleaseModel;
  readonly releaseCatalogs: ReleaseCatalogModel;
  readonly channels: ChannelModel;
  readonly analytics: AnalyticsModel;
  readonly apiKeys: ApiKeyModel;
}

interface ReleaseModel {
  findById(id: string): Promise<ReleaseRow | null>;
  findManyByScope(input: {
    scopeKey: string;
    afterReleaseId?: string;
    limit: number;
    consistency: "strong";
  }): Promise<readonly ReleaseRow[]>;
}

interface ReleaseCatalogModel {
  findByScopeKey(scopeKey: string): Promise<ReleaseCatalogRow | null>;
}
```

The public catalog model is read-only. The compiler mutation envelope is the
only writer.

API key management is local to the server process. `createHotUpdater` exposes
`apiKeys.create`, `apiKeys.list`, and `apiKeys.revoke` against the configured
direct database plugin. Neither handler exposes an API key management route;
the CLI and direct-database Console use the same local domain.

### Optimistic AoT mutation and CAS

Compilation cannot hold a database write transaction open while reading and
processing 100,000 Releases. Each mutation uses this bounded write protocol:

1. Strongly read the current generation and affected Release revisions.
2. Strongly page canonical Release rows in deterministic Release-ID order.
3. Apply the requested mutation to the snapshot in memory.
4. Compile and size-check all affected catalogs outside a transaction.
5. Open a short provider transaction with expected Release revisions and
   expected catalog generations.
6. Atomically write Release/Channel changes and all new catalog rows.
7. On `VERSION_CONFLICT`, discard output and retry a bounded number of times;
   then return an actionable conflict.

Every Release mutation increments the catalog generation. Therefore the final
generation CAS detects a concurrent write that occurred between paged reads,
provided those reads use the canonical strongly consistent access path.

`DatabaseCommit` gains conditional Release-revision and catalog-generation
expectations. `DatabaseCommitResult` returns structured `VERSION_CONFLICT`
details. A provider that cannot implement the atomic condition fails with
`DatabaseAtomicCommitUnsupportedError`; there is no “write Release now, repair
catalog later” fallback.

Provider consistency rules:

- DynamoDB queries a base-table scope partition with `ConsistentRead=true`,
  never a GSI, and uses keyset pagination.
- Firestore uses server-side strong document/query reads and transaction
  preconditions.
- Postgres/Supabase uses ordered canonical reads and commits with row
  generation/revision predicates. The generation CAS invalidates a read series
  crossed by a concurrent mutation, without keeping the write transaction open
  during compilation.
- MongoDB uses majority reads in deterministic order and a short write
  transaction with revision and generation predicates. It does not rely on an
  eventual secondary index for compiler input.
- D1 must prove a failed generation predicate aborts the entire batch; a batch
  where later statements still commit is not atomic CAS.

The maintenance command:

```text
hot-updater db catalog rebuild
```

verifies or deterministically rebuilds projections using the same CAS. It is a
migration/repair tool, not a GET-path fallback.

## AoT ReleaseCatalogCompiler

### What “AoT” means here

AoT is not native code and does not imply a binary protocol. It means range
parsing, compatibility segmentation, candidate ordering, unreachable-candidate
elimination, canonical serialization, and hashing occur when policy changes:

```text
Release mutation
  -> validate canonical policy
  -> strongly snapshot affected scopes
  -> compile deterministic catalog IR
  -> serialize canonical JSON
  -> validate complexity and byte limits
  -> short Release + catalog CAS transaction
  -> best-effort CDN purge
```

The compiled result is data, not executable code. The device runs a small
versioned reference selector over that data.

### App-version and fingerprint compilation

App-version compilation must use the exact existing semantics:

```ts
const current = coerce(currentVersion);
return current ? satisfies(current, targetAppVersion) : false;
```

The request path uses the compiler's canonical coerced version string, so
aliases such as `v1.4`, `1.4.0`, and build metadata cannot create multiple CDN
keys for the same evaluated version. A value that cannot be coerced fails
locally and never requests a catalog.

The compiler converts Release ranges into provider-neutral comparator IR,
creates disjoint intervals, orders Releases descending, builds the candidate
frontier, merges adjacent identical intervals, and interns descriptors.

Fingerprint compilation is an exact scope and needs no range program.

Conceptual stored app-version IR:

```json
{
  "schemaVersion": 1,
  "strategy": "APP_VERSION",
  "fallbackPolicy": "BUILTIN_IF_ACTIVE_INELIGIBLE",
  "releaseDescriptors": [
    {
      "releaseId": "R3",
      "kind": "BUNDLE",
      "bundleId": "B2",
      "rolloutCohortCount": 300,
      "targetCohorts": ["qa"]
    },
    {
      "releaseId": "R2",
      "kind": "BUNDLE",
      "bundleId": "B1",
      "rolloutCohortCount": 1000,
      "targetCohorts": []
    }
  ],
  "segments": [
    {
      "lower": { "version": "1.4.0", "inclusive": true },
      "upper": { "version": "2.0.0", "inclusive": false },
      "releaseIndexes": [0, 1],
      "rollbackReleaseIndexes": [0, 1]
    }
  ]
}
```

A cold app-version GET exact-reads this row, binary-searches one segment, and
serializes its update and rollback descriptors plus the envelope. A fingerprint
row stores `releaseIndexes` and `rollbackReleaseIndexes` lists instead of
segments. No Release range is parsed and no Release row is read on GET.

### Candidate frontier

Returning only one Release is incorrect because up to ten distinct Bundle IDs
can be in native crash history. For every representable selector class, retain
the first 11 distinct eligible Bundle artifacts as the update frontier.

Selector classes include numeric cohorts 1..1000, each normalized named target
cohort, default/no cohort, and an arbitrary non-targeted named cohort. The
final catalog is the union frontier. A lower Release pointing to the same
Bundle may be removed only when it can never win any class/crash subset.

Native crash-history capacity is a non-configurable protocol constant of 10.
Metadata migration clamps corrupt or legacy larger histories to the newest ten
distinct Bundle IDs. The 11-candidate proof depends on this invariant.

Rollback is a separate predecessor problem. For each compatibility segment,
retain every enabled compatible `BUNDLE` Release in newest-first order,
regardless of rollout or target cohorts. This full rollback spine is required
to answer predecessor(activeReleaseId) for arbitrarily old active devices.

The optimized update frontier and full rollback spine must be equivalent to the
unoptimized selector over:

- all numeric cohorts;
- every explicit and non-explicit named cohort class;
- every crash subset up to ten distinct Bundle IDs;
- app-version/fingerprint eligibility;
- `BUNDLE` and local `BUILTIN` fallback.

### Explicit fallback directive

Every complete catalog row includes:

```json
{ "fallbackPolicy": "BUILTIN_IF_ACTIVE_INELIGIBLE" }
```

It means that an already-active client in the same scope may select local
`BUILTIN` when no Release remains eligible and freshness/context rules allow
the transition. It is never inferred from HTTP 404, a missing row, malformed
JSON, a truncated response, or an authentication error.

### Determinism and size limits

Compiler invariants:

- identical logical input produces byte-identical output;
- object keys, target cohorts, Release descriptors, intervals, and indexes are
  canonically ordered;
- provider iteration order, locale, time, and randomness have no effect;
- full and affected-scope rebuilds produce identical bytes;
- `catalogHash = SHA-256(canonicalPayload)`.

Initial fixed compatibility ceilings:

```text
MAX_CRASHED_BUNDLES = 10
MAX_TARGET_COHORTS_PER_RELEASE = 100
MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE = 512
MAX_COMPILED_CATALOG_BYTES = 256 KiB uncompressed
```

The existing target-cohort name-length limit remains. These are protocol
constants, not provider-tunable options. The byte ceiling protects DynamoDB's
single-item boundary but is also a real product constraint: adversarial named
cohort histories can require far more frontier entries than ordinary full
rollout history.

No candidate is truncated to fit. Console/CLI preflight shows current and
projected bytes, Release/segment/cohort counts, and the rejected mutation.
Migration preflight lists each incompatible scope and offending Releases before
schema cutover.

The test corpus contains both compact long histories and full rollback spines
that deterministically exceed the cap. Oversize always fails the whole mutation
atomically; no candidate is silently dropped.

### Wire representation

Canonical JSON is stored uncompressed and served as:

```http
Content-Type: application/vnd.hot-updater.release-catalog+json; version=1
Content-Encoding: br
```

CBOR/Protobuf is deferred until profiling proves JSON parse or transfer is the
bottleneck. Compression is a CDN transport concern and not catalog identity.

## Device protocol

### Shared endpoints

```http
GET /release-catalogs/app-version/:platform/:channelKey/:canonicalAppVersion
GET /release-catalogs/fingerprint/:platform/:channelKey/:fingerprintHash
```

The server selects the authority from its deployment configuration. It is not
caller-selected tenancy and does not appear in the client path. The URL
excludes every installation-state field.

Expected complete response:

```json
{
  "schemaVersion": 1,
  "authorityId": "project_01",
  "scopeKey": "v1:app-version:project_01:ios:cHJvZHVjdGlvbg",
  "generation": 42,
  "catalogHash": "sha256:...",
  "fallbackPolicy": "BUILTIN_IF_ACTIVE_INELIGIBLE",
  "releases": [
    {
      "releaseId": "019...",
      "bundleId": "019...",
      "kind": "BUNDLE",
      "rolloutCohortCount": 300,
      "targetCohorts": ["qa"],
      "shouldForceUpdate": false,
      "message": "Production update"
    }
  ],
  "rollbackReleases": [
    {
      "releaseId": "019...",
      "bundleId": "019...",
      "kind": "BUNDLE",
      "rolloutCohortCount": 300,
      "targetCohorts": ["qa"],
      "shouldForceUpdate": false,
      "message": "Production update"
    }
  ]
}
```

`targetCohorts` is intentionally public client policy. Cohort names must be
opaque deployment buckets, never secrets or user identifiers. CLI and Console
warn about this at create/edit time.

### Artifact resolution

After local selection chooses a different Bundle:

```http
GET /artifacts/:targetBundleId/from/:currentBundleId
```

This reuses archive, signed URL, manifest diff, changed asset, and binary patch
logic. It remains Bundle-keyed. The first implementation is `private,
no-store` because Storage-signed URL expiry is not represented by the current
StoragePlugin contract.

The server compares the normal manifest route with the archive before it
returns the existing `ArtifactInfo` shape:

```text
manifestBytes = UTF-8 byte length of the exact stored target manifest text
primary(asset) = retained patch when present, otherwise served file
diffBytes = manifestBytes + sum(primary(asset).byteSize)
```

Unchanged assets cost zero. When a patch and complete file are both usable and
both sizes are known, the patch is retained only when it is strictly smaller;
equality uses the complete file. If the archive URL is usable and every
primary size is known, `diffBytes >= archiveByteSize` returns the archive-only
response. Otherwise the existing manifest-first response is preserved.

Required archive and patch sizes fail provider hydration when invalid. A
missing or invalid `downloadByteSize`, an invalid present `downloadFileHash`, a
missing hash for a transformed representation, or a safe-integer sum overflow
makes only the comparison unknown. Raw assets use the logical `fileHash` key
and may omit `downloadFileHash`. The server does not issue `HEAD` or storage
metadata probes to fill the gap. Route selection remains server-only and does
not add a native request, response field, or receipt transition. Patch failure
still follows the existing patch-to-file-to-archive fallback and is not part of
the normal-path estimate.

No artifact request is made for no-update, same-Bundle Release adoption,
`BUILTIN`, or `EMBEDDED`.

### CDN and authentication contract

Successful managed catalog responses use:

```http
Cache-Control: public, max-age=0, s-maxage=5
ETag: "<canonical-response-sha256>"
Vary: Accept-Encoding, x-api-key
```

Requirements:

- The actual provider cache key isolates host, canonical path, `x-api-key`, and
  supported content encoding. A host serves one configured Catalog authority.
- Invalid keys cannot receive a valid-key object.
- `401`, `403`, `404`, malformed/incomplete catalog errors, and `5xx` are
  `private, no-store`.
- Revocation is TTL-bounded; purge is best effort, never correctness.
- No `stale-while-revalidate` in v1.
- A bounded origin LRU and per-instance singleflight collapse simultaneous
  misses inside one runtime instance.
- Expected origin work is approximately one fill per active POP per TTL, not
  globally one fill.
- Custom GraphQL, RPC, or other upstream transports sit behind an HTTP adapter
  or proxy that exposes the v1 protocol. Adapters affected by arbitrary request
  context must keep their responses private/no-store.

Cloudflare Worker Cache API is not accepted as proof of zero Worker execution,
because it runs inside the Worker. The managed path must use a pre-Worker cache
configuration when available or report edge-shell invocations separately.

## Catalog acceptance and local selection

### Persistent receipts

For each catalog authority/scope, native stores a monotonic high-water:

```ts
interface CatalogHighWater {
  generation: number;
  catalogHash: string;
}
```

Each selected state stores a receipt:

```ts
interface PersistedSelection {
  kind: "BUNDLE" | "EMBEDDED" | "BUILTIN";
  releaseId: string | null;
  bundleId: string; // native built-in identity for EMBEDDED/BUILTIN
  authorityId: string | null;
  scopeKey: string | null;
  generation: number | null;
  catalogHash: string | null;
  channel: string;
  selectionContextHash: string | null;
}
```

Null catalog fields are allowed only for metadata-v1 migration or legacy
manual/custom installs. Every Release Catalog `BUNDLE`, `EMBEDDED`, and especially local
`BUILTIN` action writes a complete receipt. Null Release ID otherwise means
`BUILTIN`; migration-null is distinguished by its null scope/generation.

`selectionContextHash` is canonical and includes:

- normalized cohort;
- `minimumReleaseId`;
- strategy input: canonical app version or fingerprint;
- crash-history digest/version;
- selector schema version.

It deliberately includes more than cohort. A crash changes eligibility under
the same catalog generation, and a native build/floor change may reuse a
custom isolation namespace.

### Catalog acceptance table

High-water is compared within `authorityId + scopeKey` only:

| Incoming catalog                  | Action                                          |
| --------------------------------- | ----------------------------------------------- |
| `G < H.generation`                | Reject the whole response as stale              |
| `G == H.generation`, hash differs | Protocol consistency error; no transition       |
| `G == H.generation`, hash matches | Accept for selection; do not change H           |
| `G > H.generation` or no H        | Atomically persist `{G, hash}` before selection |

An unsolicited scope/authority change is rejected. A different scope is usable
only for an explicit runtime-channel check. Recording the target high-water is
allowed even if an empty first target scope remains unapplied.

If high-water persistence fails, the response exposes no actionable update.
After an authenticated catalog is accepted, high-water is persisted before
artifact work. A failed download can retry the same generation because
`G == H` is valid; an older generation cannot become authoritative again.

### Desired-state selection

The build-time `MIN_BUNDLE_ID` is not a server-known built-in manifest and is
not promoted to one. It is reinterpreted locally as `minimumReleaseId`: a
UUIDv7 timestamp floor generated with the native build. Backfilled Releases
keep old Bundle IDs, and every post-build deploy receives a newer Release ID.
Rollback disables a Release and reveals its predecessor. This preserves native
compatibility without requiring the server to know the built-in Bundle ID.
`getMinBundleId()` and native configuration names remain deprecated aliases;
new selector/API language uses `getMinimumReleaseId()`.

The JavaScript selector evaluates Release descriptors in v0 order:

1. choose the first safe newer Release that is cohort-eligible;
2. retain the current Release when it remains enabled, compatible, safe, and
   cohort-eligible;
3. otherwise choose the newest safe compatible Release below the active
   Release, ignoring rollout and target cohorts;
4. if none remains, evaluate the explicit catalog fallback directive.

Selection and permission to move backward are separate:

| Relation to active receipt                            | Lower Release or local BUILTIN                               |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| Same scope, `G > active.generation`                   | Allowed: newer canonical policy                              |
| Same scope, `G == active.generation`, context changed | Allowed: explicit local reselection                          |
| Same scope, same generation/context                   | Denied                                                       |
| Same scope, `G < active.generation`                   | Denied/invariant error                                       |
| Different scope                                       | Allowed only for an explicit switch with an eligible Release |
| First explicit switch to empty target                 | Leave current selection and channel untouched                |
| Migration receipt absent                              | Establish first authenticated receipt safely                 |

The same-generation context rule preserves `targeted-cohort-switchback` and
post-crash reselection. It does not permit arbitrary stale movement because
the catalog hash and high-water must still match.

The selected desired state maps to device work as follows:

| Desired result                                           | Action                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| Same Release/Bundle/generation/context                   | `NO_UPDATE`                                                       |
| Same Release/Bundle, fresher generation or context       | Refresh owning receipt; no download/reload                        |
| New Release, same Bundle                                 | `ADOPT_RELEASE`; no artifact request/reload                       |
| New Release, different Bundle                            | Resolve artifact, stage full receipt, verify on launch            |
| Catalog-authorized `BUILTIN`                             | Use native bytes and persist null-Release fallback receipt        |
| Candidate Bundle appears in crash history                | Skip it and continue through the compiled frontier                |
| Force flag on a metadata-only same-Bundle desired result | Adopt metadata only; force does not manufacture a byte transition |

For the current already-adopted scope, no eligible Release plus
`BUILTIN_IF_ACTIVE_INELIGIBLE` creates a persisted `BUILTIN` receipt with null
Release ID, native Bundle ID, scope, generation, channel, and context. It clears
OTA staging/files according to normal reset safety but preserves the receipt,
channel, and high-water. It is never treated as migration-null.

If an already-adopted beta scope later becomes empty, BUILTIN preserves beta so
future beta Releases are received. Only explicit `resetChannel()` returns to
the default channel.

### Commit-time stale-action CAS

High-water at fetch time is necessary but insufficient:

```text
G11 accepted -> slow B11 download
G12 accepted and installed
G11 download completes later
```

Every artifact resolution start, native install, metadata adoption, EMBEDDED,
and BUILTIN side effect must atomically recheck:

```text
incomingGeneration == highestSeenGeneration[authority + scope]
selectionContextHash == current live selectionContextHash
explicit target scope is still requested
```

Recheck before artifact resolution and again at native staging commit. On
failure, abort with `StaleReleaseCatalogError` and delete only temporary bytes.
This is a serialized native compare-and-set, not a JavaScript check followed by
an unchecked write. Equality keeps same-generation download retries valid.

## Native metadata-v2 and crash state machine

### Slot-based metadata

A flat `currentReleaseId/currentBundleId` is insufficient. Native crash
recovery already has a verified fallback and a staging Bundle; Release receipt
must be a property of each slot:

```ts
interface NativeMetadataV2 {
  schemaVersion: 2;
  stableSelection: PersistedSelection | null;
  stagingSelection: PersistedSelection | null;
  verificationPending: boolean;
  pendingTransition: {
    fromReleaseId: string | null;
    fromBundleId: string;
    toReleaseId: string | null;
    toBundleId: string;
  } | null;
  highestSeenCatalogs: Record<string, CatalogHighWater>;
  crashedBundleIds: readonly string[]; // clamped to 10
}
```

Slot semantics are explicit:

1. With no pending verification, `stagingSelection` is the verified active
   selection and `stableSelection` is null.
2. Installing changed bytes moves the verified active receipt to
   `stableSelection`, writes the candidate to `stagingSelection`, and sets
   pending verification.
3. `notifyAppReady` verifies staging, leaves it as active, clears the fallback
   slot and pending flag, and emits the directional launch report.
4. A crash deletes only the staging Bundle's local bytes, records its Bundle ID
   in crash history, restores the entire stable receipt as active staging,
   clears pending state, and does not roll back high-water.
5. Metadata-only same-Bundle adoption updates the slot that currently owns the
   Bundle. If that slot is verification-pending, adoption never promotes it.
6. Local Bundle directories referenced by either slot are preserved until the
   atomic transition finishes.

iOS uses temp-file + fsync + atomic rename; Android uses an equivalent atomic
file strategy. Current plain `Data.write`/`writeText` behavior is not enough.
Interrupted-write tests must prove the previous complete metadata survives.

The channel is inside the selection receipt and is authoritative. `getChannel`
derives/synchronizes from active metadata so crash recovery cannot restore
production bytes while leaving a separate preference at beta.

`resetChannel()` atomically clears active/stable selection and channel override
and returns to default/native state. It may retain per-scope high-water.
Isolation-key migration clears the metadata namespace including high-water.

### Crash recovery acceptance ledger

The `examples/v0.85.0` recovery gate uses this exact identity ledger:

1. T0: built-in B0, no Release receipt, empty crash history.
2. T1: deploy artifact B1 and Release R1; catalog scope S/G1 contains R1/B1.
   `dist/manifest.json` contains B1 only.
3. T2: before install, persist stable BUILTIN/B0 and staging R1/B1/S/G1,
   pending=true, high-water S=G1, transition null/B0 -> R1/B1.
4. T3: successful launch reports `UPDATE_APPLIED` B0->B1 and null->R1;
   staging R1/B1 becomes verified active.
5. T4: deploy B2 and R2; S/G2 contains R2/B2 then R1/B1.
6. T5: high-water becomes G2; stable is full R1/B1/S/G1 receipt; staging is
   R2/B2/S/G2; transition R1/B1 -> R2/B2.
7. T6: B2 crashes during module evaluation. Native records B2, deletes B2
   bytes, restores full R1/B1/S/G1 receipt, retains high-water G2, and reports
   `RECOVERED` R2/B2 -> R1/B1.
8. T7: the same authenticated G2 is reselected because crash context changed.
   R2 is skipped, R1 wins, and its receipt refreshes G1->G2 without an artifact
   request or fake `UPDATE_APPLIED`. Republishing B2 under R3 remains skipped.

This ledger is the acceptance proof that Bundle and Release identities remain
separate and that high-water is not crash-rollback state.

### Public client contract

`HotUpdater.init` and `HotUpdater.wrap` accept `baseURL` as their only network
source. The client always implements the Release Catalog, artifact,
Analytics-event, and `/version` HTTP protocol. A custom backend exposes that
protocol through an adapter or proxy instead of injecting transport callbacks
into the React Native runtime.

Public/internal observability adds:

```ts
HotUpdater.getReleaseId(): Promise<string | null>;
HotUpdater.getActiveUpdateState(): Promise<ActiveUpdateState>;
```

The application pipeline is intentionally explicit:

```text
checkForUpdate
  -> createReleaseCatalogRequest
  -> fetch catalog from baseURL
  -> native.acceptCatalogHighWater
  -> createSelectionContextHash
  -> selectDesiredRelease
  -> authorizeReleaseTransition
  -> return CheckForUpdateResult

updateBundle(result)
  -> revalidateReleaseTransition
  -> fetch artifact from baseURL only when Bundle differs
  -> native.commitSelectionIfCurrent (generation/context CAS)
  -> install/adopt/useBuiltin
```

The same pure selector is exported internally for compiler equivalence,
Console preview, legacy bridging, and deterministic tests. Only the app passes
live device inputs; provider database plugins never call it.

`CheckForUpdateResult` exposes `releaseId`, `bundleId`, and transition kind:
`INSTALL`, `ADOPT_RELEASE`, `USE_BUILTIN`, or `NO_UPDATE`.
`updateBundle` receives the full selection receipt. Legacy manual/custom calls
without a receipt continue with null Release identity until a Release Catalog check adopts
one.

`shouldForceUpdate` reloads only when changed bytes or a `BUILTIN` byte
transition is applied. Every lower-Release/BUILTIN rollback is forced. A
same-Bundle metadata adoption must not reload.

The public launch statuses from #1141 remain exactly
`UNCHANGED | UPDATE_APPLIED | RECOVERED`. “Stable” is a test phase, not a new
public status.

## Existing feature behavior after the split

### Deploy

Deploy uploads one immutable Bundle and creates one Release per platform. The
Bundle, available patch rows, Release, Channel creation, and affected catalogs
commit through the atomic mutation boundary. Failed DB commit cleans only newly
uploaded exclusive objects. Output returns both IDs plus authority, scope, and
generation.

### Rollout and target cohorts

- Mutations address Release ID.
- Rollout hashing uses Release ID and preserves membership across edits.
- `targetCohorts` is evaluated locally and is public in the catalog.
- Reducing rollout or removing a target can select a lower Release or local
  BUILTIN under the freshness/context rules.
- Console preview and device tests use the same reference selector.

### Force and message

They are Release policy and increment catalog generation. Same-Bundle adoption
of new force/message metadata does not fabricate a byte update or reload.

### Disable and enable

Disable removes a Release from the eligible compiled frontier. Existing clients
converge to the previous compatible enabled Release or the explicit local
BUILTIN fallback. Re-enable retains the original Release ID and rollout seed.
Console warns when disabling the last compatible enabled Release can return
already-active clients to native bytes.

### Rollback

Rollback updates the selected current Release to `enabled=false` through the
same revision/catalog-generation CAS as any policy edit. It creates no Release,
retains the disabled row's ID and provenance, and reveals the previous
compatible enabled Release. If none exists, the authenticated complete catalog
authorizes local `BUILTIN`. A byte rollback is always forced.

### Promote

Promote creates a target-channel Release referencing the same Bundle; it never
copies Storage bytes. Move promotion atomically creates the target Release and
disables the source. The new Release has an independent rollout seed and
`sourceReleaseId` provenance.

### Channels

- Channels own Releases, not Bundles.
- Channel deletion is rejected while Releases reference it; catalog tombstone
  generation remains even after cleanup.
- First explicit check of an empty target channel is unapplied.
- A target scope is persisted only after install/adopt.
- An already-adopted scope that later empties uses BUILTIN while retaining its
  channel.
- Only `resetChannel()` returns to the default channel.

### Patches, manifests, assets, signing

All stay Bundle-based. Release selection precedes artifact resolution. Same
Bundle reuse performs zero archive/manifest/patch request. Patch identity
remains `(targetBundleId, baseBundleId)`, signing and hash verification remain
native-authoritative, and Release ID never affects artifact hashes.

### Crash recovery

Crash history remains Bundle-keyed, capped at ten, and restored independently
of Release high-water. A new Release pointing to a crashed Bundle is skipped.
Recovery restores the complete safe selection receipt and channel.

### Delete and garbage collection

- Disable is reversible delivery policy.
- Hard-delete is allowed only for a disabled Release after confirmation.
- Bundle deletion is allowed only when no Release or patch references it.
- Shared assets are not deleted because one Release/Bundle disappears.
- `sourceReleaseId` uses `ON DELETE SET NULL`; provenance text may be retained
  separately for audit display.

### Analytics

Launch reports retain #1141 statuses and add optional from/to Release IDs.
Recovery reports R2/B2 -> R1/B1. Old events keep null Release identity.

Same-Bundle adoption does not emit `UPDATE_APPLIED`. It emits a distinct
best-effort `RELEASE_ADOPTED` analytics event immediately after atomic native
adoption. Its directional Bundle IDs may be equal. Analytics failure never
rolls back device state. Console labels Release adoption separately from Bundle
application.

## Legacy endpoint compatibility

v1 does not mount the v0 app-version or fingerprint routes and does not bridge
v0 requests into Release Catalog selection. Installed v0 binaries must keep
using their unchanged v0 endpoint. A new native build containing the v1 SDK
switches to the fresh v1 `baseURL`; v1 JavaScript is never delivered by OTA to
a v0 native binary.

## Console product changes

### Navigation and responsibility

`Releases` becomes the operational default. `Artifacts` contains immutable
Bundle, manifest, Storage, and patch information. Analytics and API Keys
stay top-level.

### Releases table and detail

Columns:

```text
Release ID | Bundle ID | Channel | Platform | Target
Enabled | Force | Rollout | Operation | Message | Created
```

Editable policy is message, target, enabled, force, rollout, and target cohorts.
Identity/provenance is read-only. Every editor/action calls Release RPCs and
uses revision/generation conflict handling.

Policy-specific UI requirements:

- rollout reduction warns that excluded active clients can move to a previous
  Release or BUILTIN;
- disabling the last eligible Release warns about same-scope local BUILTIN;
- target-cohort names warn that they are shipped to clients;
- first switch to an empty target channel is described as unapplied, while an
  already-adopted empty channel retains the channel on BUILTIN;
- force-update copy says it does not reload for metadata-only same-Bundle
  adoption;
- disabling explains previous-enabled-or-BUILTIN rollback and warns when the
  final enabled Release is being disabled;
- promote removes all “copy Storage” wording;
- hard delete is visually separate from disable.

### Compiler preflight and diagnostics

Before saving, Console runs server-authoritative preflight and shows:

- current and projected uncompressed bytes;
- 256 KiB maximum;
- Release descriptor, interval, frontier, and named-cohort counts;
- current/next generation and expected revision;
- exact affected scopes;
- mutation rejection without partial save.

Scope diagnostics show authority, canonical scope key, generation, catalog
hash, response ETag, byte size, counts, last compile, and tombstone state.
Raw canonical JSON is downloadable for debugging but not editable.

### Artifact screen

Shows Bundle hashes/URIs/build metadata, manifests/assets, patches and lineage,
all referencing Releases, and garbage-collection eligibility. The current
Bundle policy editor is deleted rather than renamed.

### Console RPCs and tests

Release RPCs replace Bundle policy RPCs:

```text
getReleases, getRelease, updateRelease, enableRelease, disableRelease
promoteRelease, deleteRelease
preflightReleaseMutation, getReleaseCatalogDiagnostics
```

Bundle RPCs remain for artifact listing, download, lineage, and safe deletion.
React Query invalidation follows Release detail/list, diagnostics, channel
counts, and analytics; it never mutates cached Bundle objects as policy.

Console route/component tests cover tables, forms, conflicts, warnings,
rollback/promote dialogs, diagnostics, and reference-safe delete. The existing
Detox `console-analytics-qa` verifies provider analytics data, not this UI, and
cannot substitute for these tests.

## CLI changes

Add:

```text
hot-updater release list
hot-updater release show <release-id>
hot-updater release update <release-id>
hot-updater release enable <release-id>
hot-updater release disable <release-id>
hot-updater release delete <release-id>
hot-updater db catalog rebuild
hot-updater db catalog preflight
```

Rollout, target, force, enabled, message, channel, and compatibility output move
to Release commands. Bundle commands show artifacts/reference counts and only
perform reference-safe artifact deletion.

Deploy prints `{release, bundle, authorityId, scopeKey, generation}`. Rollback
uses `--to-release` as the unambiguous target; Bundle targeting is explicitly
advanced. Promote accepts source Release and reports Bundle reuse with no
Storage copy. Preflight shows current/projected catalog complexity and blocks
incompatible migration/mutation.

## Provider implementation requirements

All official providers implement the same Release, catalog, strongly
consistent ordered-read, and CAS contract. A provider-specific desired-state
query is forbidden.

### AWS

- DynamoDB base-table scope partitions support strongly consistent Release
  paging and exact catalog reads.
- TransactWrite condition-checks Release revisions and catalog generation.
- A separate Release Catalog CloudFront behavior removes legacy SDK-version/Authorization
  cache fragmentation and keys only canonical path, `x-api-key`, and encoding.
- Evidence proves warm CloudFront hits skip Lambda and DynamoDB.
- IaC contract tests inspect the effective
  [CloudFront cache policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cache-key-understand-cache-policy.html),
  not only response headers.

### Cloudflare

- D1 migration adds Releases/catalogs/tombstones and proves failed CAS rolls
  back every statement.
- Managed deployment uses cache configuration in front of Worker execution
  using [Workers caching configuration](https://developers.cloudflare.com/workers/cache/configuration/).
  Generated deployment upgrades to Wrangler `>=4.69.0`, a compatible current
  date, and `cache.enabled=true`. `caches.default` inside the Worker is not
  counted as zero Worker invocations.
- Evidence separates pre-Worker hit, edge-shell execution, and D1 query counts.

### Firebase

- Firestore transaction preconditions atomically commit Release and catalogs
  within documented limits.
- Catalog traffic is tested through the Firebase Hosting rewrite, not the
  direct Function URL.
- Dynamic responses explicitly follow
  [Firebase Hosting cache behavior](https://firebase.google.com/docs/hosting/manage-cache)
  with public `s-maxage` and the required `Vary`; evidence proves warm hits
  skip Function and Firestore.

### Supabase

- Postgres tables, constraints, indexes, ordered compiler reads, and CAS
  replace the old update-info RPC.
- Edge Function performs one exact catalog read on a miss.
- The documented
  [Edge Function architecture](https://supabase.com/docs/guides/functions/architecture)
  routes a request through the gateway into an isolate; it does not document a
  reusable response-cache guarantee. The supported managed profile therefore
  uses the direct Edge Function URL in `origin-only` mode. Init generates that
  URL without an external CDN input, and `doctor` reports the mode as healthy
  while noting that every check still invokes Edge.
- Evidence reports Edge Function and Postgres counters. It does not label the
  origin-only profile as shared-CDN traffic or claim zero runtime invocations.

### Custom/Standalone/in-memory

Drizzle, Kysely, Prisma, Mongo, Standalone, mock, and in-memory implementations
receive the same rows/models/CAS contract. Custom provider docs remove
`queries`, specify strong paging and atomic conditional commit, and require a
cache partition declaration for shared transport.

## Migration

### Preflight first

Before writing schema data, migration analyzes current Bundle policy as future
Release scopes and reports:

- current/projected catalog bytes and complexity;
- target cohort count-limit violations;
- invalid/non-canonical channels or semver targets;
- source Bundles/Releases causing an incompatible scope;
- provider inability to implement required CAS/CDN guarantees.

An incompatible scope blocks cutover with an actionable report. The plan does
not claim seamless migration for policy that exceeds the new public limits.

### Data backfill

For each existing Bundle:

```text
release.id = bundle.id
release.bundle_id = bundle.id
release.revision = 1
release.kind = BUNDLE
release policy = prior Bundle policy
release.operation = DEPLOY
release.source_release_id = null
```

This preserves chronological order, native minimum-floor comparison, and the
initial rollout hash seed. Existing copied promotes remain distinct historical
Bundles; only new promote operations reuse artifacts.

Then:

1. create canonical channels/authority scope keys and persistent tombstones;
2. compile every scope;
3. compare optimized and reference selector results;
4. verify catalog hashes/limits;
5. remove policy columns from final Bundle schemas/mappers;
6. advance schema version only after all checks pass.

### Native metadata migration

Metadata-v1 Bundle IDs migrate to a v2 active receipt with null Release/scope
until the first authenticated catalog. Because backfilled Release ID equals
Bundle ID, the first Release Catalog selection can adopt exact identity without bytes.
Stable and staging Bundle slots migrate independently. Crash history is
deduplicated/clamped to ten.

The v1 SDK uses the unversioned Release Catalog routes only. Existing v0 binaries remain on a separate v0
endpoint during cutover. Runtime startup/doctor rejects a schema with
missing/inconsistent catalog projections. Analytics columns remain nullable.

## Implementation sequence inside the single PR

### 1. Freeze RED and correctness contracts

- Run the controlled #1141 RED load profile and capture provider counters.
- Add failing domain/native tests for Release/Bundle identity, disabled-Release
  rollback, same-Bundle adoption, BUILTIN fallback, high-water/context, slow stale
  commit, crash recovery, and atomic metadata.
- Add a type/runtime assertion that final `DatabasePlugin` has no `queries`.
- Freeze the existing 14 Detox scenario intent before changing fixtures.

### 2. Introduce Release domain, canonical scope, and schema migration

- Split Bundle artifact and Release policy types.
- Add Releases, catalogs, persistent tombstones, analytics IDs, constraints,
  and strongly consistent access paths.
- Add migration preflight and backfill.
- Update channel references to Releases.

### 3. Remove database decision queries

- Delete every `queries` construction/use and provider `getUpdateInfo` path.
- Add Release/catalog models and conditional commit conflicts.
- Update custom-provider and capability contracts.

### 4. Implement deterministic AoT compiler and atomic write path

- Implement range IR, fingerprint scopes, exhaustive frontier, fallback
  directive, canonical JSON/hash, limits, diagnostics, and rebuild.
- Integrate strong snapshot plus short CAS transaction in every provider.
- Prove deterministic rebuild and atomic oversize/conflict failure.

### 5. Implement the v1-only Release Catalog server and CDN boundary

- Add canonical catalog/artifact routes, auth, ETag, no-cache errors, LRU, and
  singleflight.
- Configure provider cache layers and counters.
- Remove v0 update-check routes and their SDK-version header contract.

### 6. Implement local selector and native metadata-v2

- Add authority/scope high-water, context hash, stable/staging receipts, atomic
  files, commit-time CAS, channel-in-receipt, and v1 migration.
- Add same-Bundle adoption, catalog-authorized BUILTIN, and
  Bundle-keyed crash recovery.
- Expose Release identity/state APIs and preserve #1141 launch statuses.

### 7. Move every management feature to Release

- Deploy, rollout, target, enable, force, message, rollback, promote, channels,
  deletion, analytics, and artifact resolution adopt the documented boundary.
- Keep patch/manifest/signing/storage logic Bundle-keyed.

### 8. Rebuild Console, CLI, examples, and E2E fixtures

- Introduce Releases/Artifacts UI, Release RPCs, policy warnings, diagnostics,
  preflight, and component tests.
- Move CLI management/output to Release and update generated schemas/docs.
- Migrate all existing Detox scenarios and add the missing protocol races.
- Update `.agents/skills/e2e`, `e2e-default`, and `e2e-current-pr` to the final
  #1141 route/testID/status contracts.

### 9. Prove GREEN on every provider

- Run unit/property, native, provider integration, Device E2E, Console,
  infrastructure-generation, and controlled load suites.
- Attach cache/origin/DB evidence for AWS, Cloudflare, and Firebase, plus
  distinct origin-only Edge/Postgres evidence for Supabase.
- Add changesets and compatibility documentation only after the gates pass.

## RED -> GREEN stress regression

This is a controlled load/integration test, not a unit test.

### RED on exact #1141

For each provider, pin traffic to one known POP/region and use one fixed valid
`x-api-key`. Requests share platform/channel/version or fingerprint but vary
current Bundle, minimum Bundle, and cohort.

```text
1,000 requests/second
60 seconds
60,000 requests
1 Release scope
10,000 synthetic current Bundle IDs
1,000 numeric cohorts
```

Record in one aligned time window:

- path and cache-key cardinality;
- response cache headers/status;
- edge/runtime/decision-origin invocations separately;
- exact database operations and rows read;
- p50/p95/p99, errors/timeouts, response bytes, and egress estimate.

Expected RED: cache/origin/database work grows with randomized device state.

Random/invalid keys are a separate auth-isolation test; mixing them into the
main profile would intentionally defeat caching and obscure the result.

### GREEN Release Catalog profile

The same installation distribution now uses one canonical catalog path.

Required:

- zero HTTP/application errors;
- one cache key per canonical app-version/fingerprint scope and valid key;
- at least 99% hit ratio after warm-up in the pinned profile;
- zero warm DB reads and zero warm decision-origin executions;
- separately reported unavoidable edge-shell invocations;
- origin exact reads proportional to cache fills/POP/TTL, never request count;
- one exact catalog read per cold origin fill, no Release/Bundle scan;
- per-instance cold singleflight;
- no artifact request when bytes are unchanged;
- catalog never exceeds declared limits.

### History and compiler profiles

Generate:

- 1,680 Releases matching the reported long-history case;
- a representative 100,000-Release overlapping-range history that must fail
  the 256 KiB cap atomically rather than truncate its rollback spine;
- repeated Bundle references, full/partial/zero rollout, named targets, ten
  crashes and an 11th safe artifact;
- adversarial distinct target/rollout histories that must exceed the cap.

Measure compile time and peak memory against explicit thresholds chosen from
the checked-in RED benchmark before GREEN is accepted. GET cost remains a
point read plus segment lookup regardless of history. Exact selector
equivalence is a property test; oversize fails atomically.

### Mutation under load

While load runs, mutate rollout up/down, targets, enable, compatibility,
promote, disable-to-previous rollback, and disable-to-BUILTIN. Poll the observed catalog
generation rather than sleeping for TTL, then assert each response is either
the complete old generation or complete new generation.

Also inject:

- compile oversize/failure;
- Release revision/catalog CAS conflict;
- failed purge;
- delayed old catalog;
- delayed old artifact completion;
- invalid/random API keys.

Required: no partial canonical/projection state, old actions fail native CAS,
same-generation failed download is retryable, failed purge converges at TTL,
and rebuild bytes equal active projection.

### Provider evidence

- AWS: CloudFront result, Lambda count, DynamoDB reads.
- Cloudflare: pre-Worker cache status, Worker/decision-origin count, D1 queries.
- Firebase: Hosting result, Function count, Firestore reads.
- Supabase origin-only: Edge Function count and Postgres reads; no shared-CDN
  result is claimed.

`Cache-Control` alone is not evidence.

## Existing Detox scenario migration

The exact #1141 suite contains 14 scenarios. All remain in the one-PR gate:

| Existing scenario                          | Release Catalog meaning and changed assertions                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release-ota-recovery`                     | Use the R1/B1 -> R2/B2 crash ledger; assert full receipt restore, retained G2 high-water, directional Release+Bundle report, then metadata-only G2 refresh.                              |
| `multi-asset-replacement`                  | Select Release first; keep all asset/manifest byte assertions on Bundle IDs. Assert one catalog GET and artifact GET only on byte change.                                                |
| `bspatch-archive-to-diff-ota`              | First B1 archive then B1->B2 patch. Add Release selection assertions without changing patch identity.                                                                                    |
| `bspatch-consecutive-diff-ota`             | Preserve B1->B2->B3->B4 patch lineage; track the independent Release sequence.                                                                                                           |
| `bspatch-disabled-chain-rollback`          | `/patch-release` disables RC, then RB, then RA; choose B, A, then catalog-authorized local BUILTIN. No crash-history additions.                                                          |
| `bspatch-manifest-diff-fallback`           | Preserve manifest fallback by Bundle and prove Release ID never changes diff keys.                                                                                                       |
| `runtime-channel-switch-reset`             | Persist scope/channel only after install/adopt. First empty target remains unapplied; later empty adopted scope becomes BUILTIN while retaining channel; explicit reset returns default. |
| `numeric-cohort-rollout`                   | Hash Release ID. Same-generation included->excluded context change authorizes previous Release or BUILTIN.                                                                               |
| `target-cohorts-only`                      | Catalog exposes target name; selector is local; non-target performs no artifact request.                                                                                                 |
| `target-cohorts-rollout-interaction`       | Rollout edit retains Release ID but increments generation; named/numeric contexts converge locally.                                                                                      |
| `targeted-cohort-switchback`               | Keep as architecture gate: qa -> numeric may select a lower Release in the same generation because context changed.                                                                      |
| `force-update-auto-reload`                 | Rewrite the current manual-install/manual-reload false positive. Observe the configured automatic reload without a tap; same-Bundle adoption must not reload.                            |
| `disabled-bundle-rollback-to-builtin`      | Rename policy semantics to disabled Release; newer complete empty catalog authorizes persisted local BUILTIN.                                                                            |
| `disabled-bundle-rollback-to-previous-ota` | Disable latest Release and select previous Release; artifact and patch assertions remain Bundle-based.                                                                                   |

`console-analytics-qa` is retained after scenarios and accepts nullable
directional Release IDs. It verifies provider data, not Console rendering.

### E2E harness and example changes

- Deploy fixture returns `{bundleId, releaseId, authorityId, scopeKey,
generation}` and scenario context stores both identities.
- Policy endpoint `/patch-bundle` becomes `/patch-release`; artifact endpoints
  remain Bundle-based.
- Rollout sample endpoint takes Release ID.
- Metadata capture/wait/assert reads stable/staging receipts, verification,
  channel, and high-water.
- Launch-report assertions accept from/to Release and Bundle IDs.
- Replace the legacy `update-check-request-bundle-id` helper/spec with a Release Catalog URL
  assertion proving current/minimum/cohort/crash state is absent.
- Runtime Snapshot focused routes expose active Release ID, selection kind,
  authority/scope/generation/high-water, channel, and context. Manifest display
  remains Bundle-only.
- Visibility probe reads catalog Release identity, then separately observes
  artifact resolution.
- Proxy counts catalog/artifact routes and can capture, freeze, replay, and
  delay exact generations and artifact completions. It records path
  cardinality, asserts zero artifact requests, and passes legacy routes.
- Action text distinguishes installed Release/Bundle, adopted same Bundle,
  EMBEDDED, BUILTIN, and no-update.

Update the three E2E skills to the actual route-based example and exact #1141
public statuses. Remove stale `STABLE`/`crashedBundleId` guidance where #1141
uses `UNCHANGED | UPDATE_APPLIED | RECOVERED` plus directional Bundle IDs.

### Additional meaningful device scenarios

- fingerprint initial install;
- catalog-only no-update;
- same-Bundle/new-Release adoption with zero artifact and no reload;
- delayed stale catalog after newer generation;
- slow old artifact completion after newer install;
- failed download followed by same-generation retry;
- disabled Release rollback to an older enabled Bundle;
- local BUILTIN receipt persistence;
- republished crashed Bundle skipped;
- crash then next safe update;
- crash-induced same-generation context reselection;
- runtime-channel crash restores both Bundle and channel;
- first empty target versus later-empty adopted target;
- metadata-v1 -> v2 migration on device;
- seeded ten-crash history selects the 11th safe Bundle;
- real force auto reload.

The 1,680/100,000 histories and exhaustive crash subsets are unit/property/load
tests, not Detox loops.

## Test layers and completion gates

### Unit/property

- Release validation, immutability, monotonic ID, and rollout seed stability.
- Exact semver coercion/range IR equivalence including prerelease/union ranges.
- Canonical scope/channel/version encoding.
- Full/incremental compiler byte equivalence and canonical hash.
- Frontier equivalence over 1,000 cohorts, named targets, and crash subsets.
- Explicit fallback only for complete authenticated catalogs.
- Generation/hash acceptance table and context-change authorization.
- Slow stale action CAS, same-generation retry, and concurrency serialization.
- Limits, representative 100k fit, adversarial atomic oversize rejection.
- Legacy repeated-Bundle/cohort ambiguity.
- No public/runtime `queries` property.

### Native unit/integration

- v1 migration of both Bundle slots and crash-history clamp.
- stable/staging full-receipt install, ready, crash, and restore.
- high-water not rolled back by crash/reset.
- same-Bundle adoption updates owning slot without promotion.
- BUILTIN and EMBEDDED receipts/channel semantics.
- interrupted atomic metadata write.
- commit-time generation/context CAS.

### Provider contract/integration

- Strong canonical paging and exact catalog point reads.
- Release revision + generation atomic CAS and bounded conflicts.
- Compile failure/oversize leaves old state.
- Empty tombstone generation never resets.
- Schema/backfill/reference-safe delete.
- Legacy bridge behavior.
- Cache/auth isolation including invalid/random keys and non-cacheable errors.
- Old/new complete response convergence during mutation.

### Console/CLI

- Releases/Artifacts UI boundary and Release RPC/query invalidation.
- Policy warnings, rollback/promote, conflicts, and catalog diagnostics.
- Migration/mutation size preflight.
- Structured output contains separate Release/Bundle identities.

### Device E2E

Run the migrated 14 scenarios and added protocol scenarios on iOS and Android
release builds. Preserve every existing visible marker, asset, manifest,
archive, patch, native-store, and recovery assertion at the correct identity
layer.

### Repository gates

```text
pnpm -w lint
pnpm -w build
pnpm -w test:type
pnpm -w test
pnpm -w test:integration
```

The PR also requires changesets for affected public packages, generated
provider schemas/migrations, custom-provider migration docs, managed-provider
CDN docs, updated examples, and checked-in RED/GREEN evidence.

## Final responsibility boundary

```text
Management write
  -> canonical Release rows in DB
  -> deterministic AoT compiler
  -> catalog row in the same conditional DB commit
  -> short-lived authenticated shared-cache or origin-only response

Device check
  -> shared authority/scope catalog URL
  -> high-water/hash acceptance
  -> local desired-state selection
  -> native generation/context CAS
  -> artifact resolution only when Bundle bytes differ

Native recovery
  -> atomic stable/staging selection receipts
  -> Bundle-keyed crash history
  -> full receipt/channel restore
  -> high-water never rolled back
```

The database owns canonical policy and the rebuildable AoT projection. A
provider-supported shared cache absorbs routine reads where available;
Supabase origin-only serves the same projection directly from Edge. The app
owns install-dependent selection. Native owns durable selection receipts and
crash recovery. Storage owns only immutable artifacts. No layer is asked to
act as another layer's database or policy engine.
