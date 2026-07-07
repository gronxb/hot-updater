# Database Plugin v2 Spec Draft

## Goals

`createDatabasePlugin` v2 defines a resource-oriented database contract for
Hot Updater while keeping the provider-authored core small and predictable.

The v2 contract treats these as first-class database resources and behaviors:

- bundles
- bundle patches
- cursor pagination for list queries
- optional bundle events as an append-only event sourcing log

Transaction support is not modeled as a capability flag. Providers that can
open an explicit transaction expose `beginTransaction`.

`bundleEvents` is declared by shape, not by a `capabilities` flag. If a provider
does not implement `bundleEvents`, the runtime does not expose the
`bundleEvents` resource at all for that plugin. `s3Database` intentionally omits
`bundleEvents`.

When present, `bundle_events` is not a summary table. It is the source-of-truth
event log for client telemetry reported by installed apps. Counts such as
Active, Recovered, and bundle transitions are read models derived from this
append-only log.

## Migration Acceptance Criteria

The implementation PR for this spec is complete only when all of these gates
are satisfied:

- Every `createDatabasePlugin` call site is migrated to the v2 surface.
- Deploy, console, and `createHotUpdater` paths are updated for the new runtime
  shape.
- `standaloneRepository` and request-handler adapter paths are migrated, not
  only provider package entry points.
- `bundle_patches` remains a first-class resource and is not hidden inside
  bundle-only writes.
- Telemetry-capable providers add `bundle_events` as the append-only event
  sourcing resource for client telemetry.
- Providers that cannot support telemetry, such as `s3Database`, omit
  `bundleEvents` from the plugin core and surface telemetry as unsupported
  through the missing runtime field.
- All standalone verification profiles pass through `hot-updater-agent`:
  `standalone-s3`, `standalone-drizzle`, `standalone-prisma`,
  `standalone-kysely`, and `standalone-mongodb`.
- Because this migration is a large refactor, existing integration test
  scenarios that exercise the HTTP path must pass without scenario changes.
- Standalone HTTP integration scenarios must keep their existing route and
  request/response behavior; only the database implementation beneath them may
  change.
- The migration lands as one coherent implementation commit.
- The pushed PR has green CI.
- No temporary patches, skipped paths, provider stubs, or TODO-only
  compatibility shims are accepted as completion.

Suggested verification command shape:

```sh
hot-updater-agent verify -platform full -profile <standalone-profile> \
  -env-target examples/v0.85.0/.env.hotupdater
```

## Top-Level Plugin Spec

`factory` is not the right public word for v2. It describes an implementation
pattern, but the database plugin boundary needs to express lifecycle:

- configure provider credentials and clients
- expose the runtime database core
- close provider resources when the caller is done

Use `connect` for the top-level entry point. It does not require a physical TCP
connection; it means "open a configured database plugin runtime".

```ts
export type MaybePromise<T> = T | Promise<T>;

export interface DatabasePluginSpec {
  readonly name: string;
  readonly connect: (config: unknown) => MaybePromise<DatabasePluginCore>;
}
```

Provider authors should not write generic parameters at the
`createDatabasePlugin` call site. Type inference may exist in the TypeScript
implementation, but the documented authoring surface is the object shape:
`name` plus `connect(config)`.

## Plugin Core Contract

`connect` returns the provider-authored database core directly. There is no
`adapter` wrapper and no setup lifecycle in the provider-facing runtime object.

```ts
export interface DatabasePluginCore {
  readonly beginTransaction?: () => Promise<DatabaseTransaction>;

  readonly bundles: BundleResource;
  readonly bundlePatches: BundlePatchResource;
  readonly bundleEvents?: BundleEventResource;
  readonly updateInfo?: UpdateInfoRepository;

  readonly close?: () => Promise<void>;
}

export interface DatabasePluginRuntime {
  readonly bundles: RuntimeBundleRepository;
  readonly bundlePatches: RuntimeBundlePatchRepository;
  readonly bundleEvents?: RuntimeBundleEventRepository;
  readonly updateInfo?: UpdateInfoRepository;

  readonly commit: (params?: DatabaseCommitParams) => Promise<void>;

  readonly close?: () => Promise<void>;
}
```

Lifecycle semantics:

- `connect` is called by deploy, console, and `createHotUpdater` paths to open a
  configured runtime.
- `connect` returns the provider-authored core object directly.
- `createDatabasePlugin` wraps the core with one runtime `commit` method.
- `createDatabasePlugin` also wraps resource reads and staged writes with an
  instance-scoped identity map.
- Provider cores declare `beginTransaction` only when the provider can expose an
  explicit transaction handle.
- Provider resources never declare or call `commit`; `commit()` is generated by
  `createDatabasePlugin` on the runtime object.
- `DatabaseTransaction.commit` and `DatabaseTransaction.rollback` live only on
  the object returned from `beginTransaction`.
- Normal Hot Updater callers do not call `beginTransaction`; the helper consumes
  the provider core's transaction hook while running runtime `commit`.
- Repository and resource methods use a params-only calling convention:
  `method(params)`.
- Methods without domain params, such as `beginTransaction` and `commit`, take no
  required arguments.
- Request metadata and platform bindings are not database method arguments.
- Runtime paths should not implicitly create, migrate, or validate database
  resources on every request.
- Database setup belongs to low-level schema tooling owned by
  `createDatabasePlugin` and CLI setup/init flows, not to the provider-facing
  core object.

## Declarative Surface Checkpoints

Use these checks to decide whether the plugin surface is still declarative.
The public provider contract should describe resources and the connection
boundary.
Provider internals may still use SQL, SDK calls, switch statements, and batch
builders.

Pass checklist:

- The top-level provider spec is small: `name` plus `connect`.
- `connect` returns `DatabasePluginCore` directly; there is no `adapter`
  wrapper.
- Provider authors do not pass schema, version, setup, or mode fields.
- The core object is organized by resources: `bundles`, `bundlePatches`,
  optional `bundleEvents`, and optional `updateInfo`.
- Basic features are required by shape, not described by `capabilities` flags.
- Optional features are also declared by shape; if `bundleEvents` is omitted, the
  runtime omits the `bundleEvents` resource for that provider.
- Runtime writes enter through resource staging methods; `commit()` or
  `commit({ batch })` is the public flush boundary.
- Provider write implementations are co-located with each resource repository.
- Runtime resource write methods stage mutations into an instance identity map;
  provider resource primitive methods persist them.
- Reads are read-your-writes inside the same runtime instance.
- Runtime mutations are internal to `createDatabasePlugin`; provider resources
  expose concrete storage operations such as `insert`, `update`, `delete`,
  `replaceForBundle`, and `append`.
- Transactions are an optional primitive for providers that can expose one; they
  are not a global execution mode.
- Hot Updater workflows such as deploy, rollback, console, and update check do
  not appear as provider methods.

Smells that the surface is drifting back to imperative:

- Provider specs contain `version`, `capabilities`, `supports*`, or mode flags.
- A caller must decide between provider-specific methods to complete one Hot
  Updater workflow.
- Setup appears in the provider-facing runtime object.
- Schema creation, migration, or validation happens implicitly inside `connect`
  or on every runtime request.
- Bundle patches are hidden behind bundle-only methods.
- Telemetry events are silently dropped instead of being absent or unsupported
  when `bundleEvents` is not implemented.
- The public core object exposes provider operations such as raw SQL, SDK clients,
  upload steps, or CLI actions.
- Cross-resource ordering rules are spread across repositories instead of being
  owned by runtime `commit`.
- A staged insert cannot be read before runtime `commit`.
- `createHotUpdater` reuses a cross-request database runtime instance instead of
  creating a request-scoped runtime.

Current verdict:

- The provider-facing spec is declarative if it remains `name + connect`.
- `connect` is shallow enough when it returns the resource core directly.
- Runtime `commit` is declarative at the boundary because callers flush staged
  resource changes instead of choosing provider-specific execution paths.
- Provider write code is easier to maintain when each resource owns concrete
  primitive methods instead of a generic `apply` interpreter.
- The identity map belongs to the runtime wrapper, not to provider code.
- The D1 example should show enough implementation to be teachable, but that
  imperative detail must stay inside the core object implementation.

## Runtime Identity Map

`createDatabasePlugin` should provide an instance-scoped identity map above the
provider core. This is not a full Unit of Work API exposed to provider authors.
It is a runtime wrapper behavior that gives Hot Updater read-your-writes
semantics.

Identity map rules:

- Every `DatabasePluginRuntime` instance owns one identity map.
- Runtime resource write methods stage mutations into that identity map.
- Runtime `commit` expands staged mutations into provider primitive write
  methods; provider code does not implement identity map behavior.
- A staged `bundle.insert` must be visible through `runtime.bundles.getById`
  before runtime `commit` calls `core.bundles.insert`.
- Staged bundle updates must read as merged bundle records before provider
  writes run.
- Staged bundle deletes must read as `null` before provider writes run.
- `bundles.list` overlays staged bundle inserts, updates, and deletes onto
  provider results before returning.
- `bundlePatches.list` overlays staged `replaceForBundle`, `deleteForBundle`,
  and `deleteForBaseBundle` mutations before returning.
- `bundleEvents.list` overlays staged `append` events before returning when the
  provider exposes `bundleEvents`.
- Staged write methods retain resource data only; they do not retain a
  per-mutation ambient state or transaction handle.
- Successful runtime `commit` clears staged entries that were applied.
- Failed runtime `commit` keeps staged entries so the caller can retry or surface
  the failure with the same in-memory view.

This matters for `createHotUpdater`:

- `createHotUpdater` should create a database runtime wrapper/UOW instance per
  request for request-driven server paths.
- The request handler should reuse that same runtime instance for every read and
  write inside the request.
- Request-scoped runtime does not require a new provider core, TCP connection,
  pool, SDK client, or storage client per request. Provider cores may reuse
  long-lived clients.
- CLI flows such as deploy, rollback, promote, and console actions may use one
  command/action-scoped runtime instance.
- Cross-request identity maps are not allowed; persistent cross-request caching
  belongs in provider code or an explicit cache layer, not in the runtime
  identity map.

Example read-your-writes flow:

```ts
const database = await d1Database(config);

await database.bundles.insert({ bundle });

// Reads from the identity map even though provider writes have not run yet.
const staged = await database.bundles.getById({ bundleId: bundle.id });

await database.commit();
```

## Transaction Boundary Decision

Use this decision rule when choosing where `begin`, provider writes, and
`commit` live:

- Provider cores declare `beginTransaction` only when the provider can expose a
  real transaction handle.
- Provider resources declare concrete write primitives for their own resource.
- Provider resources do not declare `commit` and do not call
  `transaction.commit()`.
- `createDatabasePlugin` generates the public runtime `commit(params?)` method.
- `DatabaseTransaction.commit` and `DatabaseTransaction.rollback` are declared on
  the object returned from `beginTransaction`.
- Runtime `commit` is the transaction boundary over staged mutations.
- For PostgreSQL, `BEGIN`, `COMMIT`, and `ROLLBACK` belong to
  `beginTransaction` and the `createDatabasePlugin` runtime commit wrapper.
- Transactional providers expose a transaction-bound `core` from
  `beginTransaction`; resource methods close over the pool/client they should
  use and execute only their own primitive write.
- `createDatabasePlugin` owns staging, ordering, transaction finalization, and
  hook execution.

Provider primitive write methods:

```ts
core.bundles.insert({ bundle });
core.bundles.update({ bundleId, patch });
core.bundles.delete({ bundleId });

core.bundlePatches.replaceForBundle({ bundleId, patches });
core.bundlePatches.deleteForBundle({ bundleId });
core.bundlePatches.deleteForBaseBundle({ baseBundleId });

core.bundleEvents?.append({ event });
```

Recommended runtime layering:

```ts
await runtime.commit(); // or runtime.commit({ batch })

// createDatabasePlugin:
// 1. validate commit({ batch }) against declared resources before staging
// 2. reject bundleEvent mutations if core.bundleEvents is absent
// 3. stage the provided batch if commit({ batch }) was called
// 4. snapshot staged mutations from the identity map
// 5. open transaction if the provider exposes one
// 6. write through tx.core when a transaction is open, otherwise through core
// 7. append bundle events only when core.bundleEvents exists
// 8. call tx.commit() once, or tx.rollback() once on failure
// 9. clear the applied staged mutations after success
```

PostgreSQL sketch:

```ts
connect({ pool }) {
  const createCore = (db: PgPool | PgClient): DatabasePluginCore => ({
    async beginTransaction() {
      if (!("connect" in db)) {
        throw new Error("Nested database transactions are not supported.");
      }

      const client = await db.connect();
      await client.query("BEGIN");

      return {
        core: createCore(client),
        async commit() {
          await client.query("COMMIT");
          client.release();
        },
        async rollback() {
          await client.query("ROLLBACK");
          client.release();
        },
      };
    },

    bundles: {
      async getById({ bundleId }) {
        const result = await db.query("SELECT * FROM bundles WHERE id = $1", [
          bundleId,
        ]);

        return result.rows[0] ? toBundleRecord(result.rows[0]) : null;
      },

      async insert({ bundle }) {
        await db.query(insertBundleSql, toBundleInsertValues(bundle));
      },

      async update({ bundleId, patch }) {
        const update = toBundleUpdateStatement(bundleId, patch);
        await db.query(update.sql, update.params);
      },

      async delete({ bundleId }) {
        await db.query("DELETE FROM bundles WHERE id = $1", [bundleId]);
      },
    },

    bundlePatches: {
      async list(query) {
        return listBundlePatches(db, query);
      },

      async replaceForBundle({ bundleId, patches }) {
        await db.query("DELETE FROM bundle_patches WHERE bundle_id = $1", [
          bundleId,
        ]);

        for (const patch of patches) {
          await db.query(insertBundlePatchSql, toBundlePatchValues(patch));
        }
      },

      async deleteForBundle({ bundleId }) {
        await db.query("DELETE FROM bundle_patches WHERE bundle_id = $1", [
          bundleId,
        ]);
      },

      async deleteForBaseBundle({ baseBundleId }) {
        await db.query(
          "DELETE FROM bundle_patches WHERE base_bundle_id = $1",
          [baseBundleId],
        );
      },
    },

    bundleEvents: {
      async list(query) {
        return listBundleEvents(db, query);
      },

      async append({ event }) {
        await db.query(insertBundleEventSql, toBundleEventValues(event));
      },
    },
  });

  return createCore(pool);
}
```

## Transaction Model

```ts
export interface DatabaseTransaction {
  readonly core: DatabasePluginCore;
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}
```

Method argument convention:

- Repository and resource methods use `(params)`.
- `params` is always an object when present. Scalar positional params such as
  `(bundleId)` are not part of the v2 surface.
- Methods without domain params, such as `beginTransaction` and `commit`, take
  no required arguments.
- `commit` uses `(params = {})`.

No ambient operation argument:

- There is no first ambient argument in the database plugin v2 method surface.
- Request metadata belongs to the HTTP/runtime layer, not to database resource
  methods.
- Provider configuration belongs in `connect(config)`.
- Query filters, ids, bundles, patches, events, and commit batches belong in
  params objects.
- Transaction state is represented by a transaction-bound `core` returned from
  `beginTransaction`, not by a field injected into every method call.
- Cloudflare Worker bindings such as `env.DB`, `env.BUCKET`, and
  `env.JWT_SECRET` should not be routed through every database method as
  an operation argument. In supported Worker runtimes, import `env` from
  `cloudflare:workers` in a Worker-only entry/subpath and pass the binding into
  the provider config at construction time.

Cloudflare Worker binding flow:

`cloudflare:workers` makes bindings importable from top-level code and deeply
nested helpers in supported Worker runtimes. Worker-specific Hot Updater entries
should use that import to bind D1/R2 resources once, then keep repository
methods focused on params-only database operations.

```ts
import { env } from "cloudflare:workers";
import { createHotUpdater } from "@hot-updater/server";
import { d1Database, r2Storage } from "@hot-updater/cloudflare/worker";

const hotUpdater = createHotUpdater({
  database: d1Database({
    database: env.HOT_UPDATER_D1,
  }),
  storages: [
    r2Storage({
      bucket: env.HOT_UPDATER_BUCKET,
      jwtSecret: env.JWT_SECRET,
      publicBaseUrl: env.HOT_UPDATER_PUBLIC_BASE_URL,
    }),
  ],
});

export default {
  fetch(request: Request) {
    return hotUpdater.handler(request);
  },
};
```

The `cloudflare:workers` import is Worker-runtime-specific. It must stay out of
Node/CLI/database management entrypoints and should be isolated to worker-only
exports such as `@hot-updater/cloudflare/worker` or generated Worker files. Do
not call binding I/O at module initialization time; capture the binding object
there and execute `prepare`, `run`, `get`, or `put` inside request-driven
repository methods. If a resolver truly needs the incoming request, pass only
request metadata through the HTTP/storage layer; do not use database resource
methods to ferry Cloudflare bindings.

For a Cloudflare D1 provider, `env.DB` should be captured in provider
configuration, not read from a method argument:

```ts
const getById: BundleResource["getById"] = async ({ bundleId }) => {
  const row = await database
    .prepare("SELECT * FROM bundles WHERE id = ? LIMIT 1")
    .bind(bundleId)
    .first<BundleRow>();

  return row ? toBundleRecord(row) : null;
};
```

During runtime commit, `createDatabasePlugin` switches to the transaction-bound
core only when the provider core declares `beginTransaction`:

```ts
const transaction = await core.beginTransaction();
const writeCore = transaction.core;

await writeCore.bundles.insert({ bundle });
await transaction.commit();
```

Transaction semantics:

- `beginTransaction` is optional.
- If `beginTransaction` returns a transaction-bound core, runtime commit must use
  that core for all provider primitive writes inside the transaction.
- Provider resource methods never call `transaction.commit()` or
  `transaction.rollback()`.
- If `createDatabasePlugin` opens a transaction for runtime `commit`, it owns
  `transaction.commit()` and `transaction.rollback()`.
- Normal Hot Updater paths do not expose `beginTransaction` or transaction
  handles to callers.
- Providers without explicit transactions run provider primitive writes as a
  best-effort ordered write sequence and surface any failure.
- Best-effort commits are not atomic. If a provider write fails midway,
  previously executed primitive writes may already be durable.
- Staged runtime writes store only domain mutation data. Transaction scope is
  resolved only inside `commit(params)`.

## Bundle Records

Patch data is split from the bundle write model. Deprecated inline patch fields
remain compatibility read-model concerns, not the v2 write source of truth.

```ts
type DeprecatedPatchKeys =
  | "patches"
  | "patchBaseBundleId"
  | "patchBaseFileHash"
  | "patchFileHash"
  | "patchStorageUri";

export type DatabaseBundleRecord = Omit<Bundle, DeprecatedPatchKeys>;

export interface DatabaseBundlePatch {
  readonly id?: string;
  readonly bundleId: string;
  readonly baseBundleId: string;
  readonly baseFileHash: string;
  readonly patchFileHash: string;
  readonly patchStorageUri: string;
  readonly orderIndex: number;
}
```

Patch identity rules:

- A provider must persist exactly one patch row/document per
  `(bundleId, baseBundleId)` pair.
- If `DatabaseBundlePatch.id` is omitted, `createDatabasePlugin` materializes it
  as `${bundleId}:${baseBundleId}` before staging or persisting the patch.
- If `DatabaseBundlePatch.id` is provided, it must equal
  `${bundleId}:${baseBundleId}`. Provider-specific random ids are not allowed.
- `orderIndex` controls read ordering only; it is not part of patch identity.
- `bundlePatch.replaceForBundle` replaces the complete patch set for the target
  bundle and therefore owns the deterministic ids for that bundle's patches.

## Pagination

Cursor pagination is part of the v2 contract. Providers may implement it using
SQL cursors, ordered key scans, document pagination, or in-memory slicing for
small document-backed stores, but the external shape is always the same.

```ts
export interface CursorPage<T> {
  readonly data: readonly T[];
  readonly pagination: {
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
    readonly nextCursor: string | null;
    readonly previousCursor: string | null;
  };
}
```

## Bundle Repository

```ts
export interface RuntimeBundleRepository extends BundleRepository {
  readonly insert: (
    params: { readonly bundle: DatabaseBundleRecord },
  ) => Promise<void>;

  readonly update: (
    params: {
      readonly bundleId: string;
      readonly patch: Partial<DatabaseBundleRecord>;
    },
  ) => Promise<void>;

  readonly delete: (
    params: { readonly bundleId: string },
  ) => Promise<void>;
}

export interface BundleResource extends BundleRepository {
  readonly insert: (
    params: { readonly bundle: DatabaseBundleRecord },
  ) => Promise<void>;

  readonly update: (
    params: {
      readonly bundleId: string;
      readonly patch: Partial<DatabaseBundleRecord>;
    },
  ) => Promise<void>;

  readonly delete: (
    params: { readonly bundleId: string },
  ) => Promise<void>;
}

export interface BundleRepository {
  readonly getById: (
    params: { readonly bundleId: string },
  ) => Promise<DatabaseBundleRecord | null>;

  readonly list: (
    params: BundleListQuery,
  ) => Promise<CursorPage<DatabaseBundleRecord>>;
}

export interface BundleListQuery {
  readonly where?: BundleWhere;
  readonly limit: number;
  readonly cursor?: {
    readonly after?: string;
    readonly before?: string;
  };
  readonly orderBy?: {
    readonly field: "id";
    readonly direction: "asc" | "desc";
  };
}
```

## Bundle Patch Repository

```ts
export interface RuntimeBundlePatchRepository extends BundlePatchRepository {
  readonly replaceForBundle: (
    params: {
      readonly bundleId: string;
      readonly patches: readonly DatabaseBundlePatch[];
    },
  ) => Promise<void>;

  readonly deleteForBundle: (
    params: { readonly bundleId: string },
  ) => Promise<void>;

  readonly deleteForBaseBundle: (
    params: { readonly baseBundleId: string },
  ) => Promise<void>;
}

export interface BundlePatchResource extends BundlePatchRepository {
  readonly replaceForBundle: (
    params: {
      readonly bundleId: string;
      readonly patches: readonly DatabaseBundlePatch[];
    },
  ) => Promise<void>;

  readonly deleteForBundle: (
    params: { readonly bundleId: string },
  ) => Promise<void>;

  readonly deleteForBaseBundle: (
    params: { readonly baseBundleId: string },
  ) => Promise<void>;
}

export interface BundlePatchRepository {
  readonly list: (
    params: BundlePatchListQuery,
  ) => Promise<CursorPage<DatabaseBundlePatch>>;
}

export interface BundlePatchListQuery {
  readonly where?: {
    readonly bundleId?: string;
    readonly baseBundleId?: string;
    readonly bundleIdIn?: readonly string[];
    readonly baseBundleIdIn?: readonly string[];
  };
  readonly limit: number;
  readonly cursor?: {
    readonly after?: string;
    readonly before?: string;
  };
  readonly orderBy?: {
    readonly field: "bundleId" | "baseBundleId" | "orderIndex";
    readonly direction: "asc" | "desc";
  };
}
```

## Bundle Event Repository

Bundle events are an optional v2 resource backed by the `bundle_events` table.
Providers that implement `bundleEvents` support appending telemetry events.
Providers that omit `bundleEvents` do not expose the `bundleEvents` resource on
the runtime object.

`s3Database` does not implement `bundleEvents`.

The table is append-only. Providers should not update or delete bundle events as
part of normal Hot Updater workflows. Event summaries are derived read models,
not provider-authored source-of-truth APIs.

`install_id` identifies one native app installation. `user_id` is a separate,
optional application-level identifier for event analysis after the host app knows
who is signed in. It defaults to `null`, is set explicitly with
`HotUpdater.setUserId()`, and is stored beside `install_id` so event pipelines can
aggregate by install, by user, or keep the two identities independent.

```ts
export interface RuntimeBundleEventRepository extends BundleEventRepository {
  readonly append: (
    params: { readonly event: DatabaseBundleEventInput },
  ) => Promise<void>;
}

export interface BundleEventResource extends BundleEventRepository {
  readonly append: (
    params: { readonly event: DatabaseBundleEvent },
  ) => Promise<void>;
}

export interface BundleEventRepository {
  readonly list: (
    params: BundleEventListQuery,
  ) => Promise<CursorPage<DatabaseBundleEvent>>;
}
```

Table shape:

| Column | Type | Required | Description | Source |
|---|---:|---:|---|---|
| `id` | `uuid` | yes | Event id. Generated as UUIDv7 by the server. Also represents server receive/order time. | Server |
| `kind` | `text` | yes | Event kind. Initial value: `APP_READY`. | Server/client event type |
| `install_id` | `text` | yes | Opaque app-installation id. Not a user id or raw device id. Stable for one app install, may change after reinstall. | `HotUpdater.getInstallId()` |
| `active_bundle_id` | `uuid` | yes | Bundle currently running after `notifyAppReady`. Used for Active count. | `HotUpdater.getBundleId()` |
| `previous_active_bundle_id` | `uuid` | no | Bundle that this `install_id` was running before the current event. Used to count transitions from old bundle to new bundle. | Server from previous event, or client cache |
| `crashed_bundle_id` | `uuid` | no | Bundle that crashed and caused recovery. Present when status is `RECOVERED`. Used for Recovered count. | `HotUpdater.notifyAppReady().crashedBundleId` |
| `platform` | `text` | yes | Client platform: `ios` or `android`. | Hot Updater runtime/constants |
| `channel` | `text` | yes | Current update channel. | `HotUpdater.getChannel()` |
| `app_version` | `text` | no | Native app version. | `HotUpdater.getAppVersion()` |
| `fingerprint_hash` | `text` | no | Current native/build fingerprint hash. | `HotUpdater.getFingerprintHash()` |
| `cohort` | `text` | no | Rollout cohort used for update eligibility. | `HotUpdater.getCohort()` |
| `user_id` | `text` | no | Optional application user id. Defaults to null until configured by the app. | `HotUpdater.setUserId()` |
| `payload` | `json` | yes | Event-specific extra data. Do not put core query/group-by fields only in payload. | Client/server |

Type shape:

```ts
export type BundleEventKind = "APP_READY";

export interface DatabaseBundleEventInput {
  readonly kind: BundleEventKind;
  readonly installId: string;
  readonly activeBundleId: string;
  readonly previousActiveBundleId?: string | null;
  readonly crashedBundleId?: string | null;
  readonly platform: Platform;
  readonly channel: string;
  readonly appVersion?: string | null;
  readonly fingerprintHash?: string | null;
  readonly cohort?: string | null;
  readonly userId?: string | null;
  readonly payload: BundleEventPayload;
}

export interface DatabaseBundleEvent extends DatabaseBundleEventInput {
  readonly id: string;
}

export type BundleEventPayload = AppReadyBundleEventPayload;

export interface AppReadyBundleEventPayload {
  readonly status: "STABLE" | "RECOVERED";
  readonly sdkVersion: string;
  readonly defaultChannel: string;
  readonly isChannelSwitched: boolean;
}

export interface BundleEventListQuery {
  readonly where?: {
    readonly kind?: BundleEventKind;
    readonly installId?: string;
    readonly activeBundleId?: string;
    readonly previousActiveBundleId?: string;
    readonly crashedBundleId?: string;
    readonly platform?: Platform;
    readonly channel?: string;
    readonly appVersion?: string;
    readonly fingerprintHash?: string;
    readonly cohort?: string;
    readonly userId?: string;
  };
  readonly limit: number;
  readonly cursor?: {
    readonly after?: string;
    readonly before?: string;
  };
  readonly orderBy?: {
    readonly field: "id";
    readonly direction: "asc" | "desc";
  };
}
```

`RuntimeBundleEventRepository.append` accepts `DatabaseBundleEventInput`.
`createDatabasePlugin` generates the UUIDv7 `id` before staging the
`bundleEvent.append` mutation. It may also fill `previousActiveBundleId` from
the previous event for the same `installId` when the client did not provide it.

Initial event kind:

### `APP_READY`

Reported after the app calls `HotUpdater.notifyAppReady()`.

Expected payload:

```json
{
  "status": "STABLE",
  "sdkVersion": "0.x.x",
  "defaultChannel": "production",
  "isChannelSwitched": false
}
```

## Update Info Repository

`updateInfo` remains optional. If omitted, core can derive update info by
querying `bundles` and `bundlePatches`.

```ts
export interface UpdateInfoRepository {
  readonly get: (
    params: GetBundlesArgs,
  ) => Promise<UpdateInfo | null>;
}
```

## Runtime Commit Model

Runtime staged writes flush through one public `commit`. `DatabaseMutation` is
the runtime wrapper's internal staging format and the optional
`commit({ batch })` input shape. Provider resources do not receive these
mutations and do not interpret mutation kinds.

During commit, `createDatabasePlugin` expands staged mutations into concrete
provider primitive writes such as `core.bundles.insert`,
`core.bundlePatches.replaceForBundle`, and `core.bundleEvents?.append`.

```ts
export interface DatabaseCommitBatch {
  readonly mutations: readonly DatabaseMutation[];
}

export interface DatabaseCommitParams {
  readonly batch?: DatabaseCommitBatch;
}

export type DatabaseMutation =
  | BundleMutation
  | BundlePatchMutation
  | BundleEventMutation;

export type BundleMutation =
  | { readonly kind: "bundle.insert"; readonly bundle: DatabaseBundleRecord }
  | {
      readonly kind: "bundle.update";
      readonly bundleId: string;
      readonly patch: Partial<DatabaseBundleRecord>;
    }
  | { readonly kind: "bundle.delete"; readonly bundleId: string };

export type BundlePatchMutation =
  | {
      readonly kind: "bundlePatch.replaceForBundle";
      readonly bundleId: string;
      readonly patches: readonly DatabaseBundlePatch[];
    }
  | { readonly kind: "bundlePatch.deleteForBundle"; readonly bundleId: string }
  | {
      readonly kind: "bundlePatch.deleteForBaseBundle";
      readonly baseBundleId: string;
    };

export type BundleEventMutation = {
  readonly kind: "bundleEvent.append";
  readonly event: DatabaseBundleEvent;
};
```

Commit semantics:

- Runtime resource methods such as `bundles.insert` and
  `bundlePatches.replaceForBundle` stage mutations in the identity map.
- `createDatabasePlugin` exposes one public `commit(params?)` method.
- Calling `commit()` applies the currently staged mutations.
- Calling `commit({ batch })` validates the batch against declared
  resources first, stages the provided batch, then applies the staged mutations.
- `commit({ batch })` must reject unsupported resource mutations before
  opening a transaction or mutating the identity map.
- `createDatabasePlugin` invokes only the provider primitive writes required by
  the current staged mutations.
- Provider resources never receive `DatabaseMutation` objects.
- Runtime write methods stage domain mutation data only.
- `bundle.insert` inserts a bundle without patch metadata.
- `bundle.update` updates only bundle columns.
- `bundle.delete` deletes only the bundle row or document. Workflows that need
  patch cleanup include `bundlePatch.deleteForBundle` and/or
  `bundlePatch.deleteForBaseBundle` in the same batch.
- `bundlePatch.replaceForBundle` replaces the complete patch set for a target
  bundle.
- `bundlePatch.deleteForBundle` deletes all patches produced for a target
  bundle.
- `bundlePatch.deleteForBaseBundle` deletes all patches that depend on a base
  bundle.
- `runtime.bundleEvents` exists only when the provider core declares
  `bundleEvents`.
- `runtime.bundleEvents.append` accepts event input without an id; runtime
  generates a UUIDv7 id before staging the mutation.
- `commit({ batch })` rejects `bundleEvent.append` mutations when the
  provider core omits `bundleEvents`.
- `bundleEvent.append` appends one server-enriched bundle event to the
  append-only `bundle_events` log.

Commit ordering:

| Order | Staged mutation | Provider primitive | Runtime rule |
|---:|---|---|---|
| 1 | `bundlePatch.deleteForBaseBundle` | `core.bundlePatches.deleteForBaseBundle` | Run before deleting a bundle that may be used as a patch base. |
| 2 | `bundlePatch.deleteForBundle` | `core.bundlePatches.deleteForBundle` | Run before deleting or replacing the target bundle's patch set. |
| 3 | `bundle.delete` | `core.bundles.delete` | Deletes only the bundle row/document. Patch cleanup must be explicit in the batch. |
| 4 | `bundle.insert` | `core.bundles.insert` | Inserts bundle metadata without inline patch data. |
| 5 | `bundle.update` | `core.bundles.update` | Updates bundle columns only. |
| 6 | `bundlePatch.replaceForBundle` | `core.bundlePatches.replaceForBundle` | Replaces the complete patch set after the target bundle exists. |
| 7 | `bundleEvent.append` | `core.bundleEvents.append` | Runs only when `bundleEvents` exists; event mutation is rejected before staging otherwise. |

The runtime may coalesce multiple staged mutations for the same resource key
before applying them, but the externally observable result must match this
ordering. Provider resources must not perform cross-resource cleanup implicitly.

## Low-Level Schema

The database schema is owned by `createDatabasePlugin`, not by each provider
spec. Provider authors should not pass a schema into `createDatabasePlugin`.

`DatabaseSchemaSpec` exists as a low-level tool for schema validation and
migration helpers. It is not passed through `DatabasePluginSpec` or `connect`.

```ts
export interface DatabaseSchemaSpec {
  readonly version: "0.32.0";
  readonly resources: {
    readonly bundles: "bundles";
    readonly bundlePatches: "bundle_patches";
    readonly bundleEvents?: "bundle_events";
  };
}
```

Required storage resources:

- `bundles`
- `bundle_patches`

Optional telemetry storage resource:

- `bundle_events`

`s3Database` omits the optional `bundleEvents` resource and does not create a
`bundle_events` table or object collection.

## Migration Bridge

Existing database plugins expose bundle workflow methods such as
`appendBundle`, `updateBundle`, `deleteBundle`, and `commitBundle`. The v2
migration must move workflow orchestration out of providers and into
`createDatabasePlugin`.

Legacy-to-v2 mapping:

| Legacy surface | v2 runtime/provider shape |
|---|---|
| `appendBundle(bundle)` | `runtime.bundles.insert({ bundle: bundleRecord })` plus `runtime.bundlePatches.replaceForBundle({ bundleId: bundle.id, patches })` when the bundle carries patch artifacts. |
| `updateBundle(id, patch)` | `runtime.bundles.update({ bundleId: id, patch: bundlePatch })` and, when patch artifacts change, `runtime.bundlePatches.replaceForBundle({ bundleId: id, patches })`. |
| `deleteBundle(id)` | Batch explicit `bundlePatch.deleteForBundle`, `bundlePatch.deleteForBaseBundle`, and `bundle.delete` mutations according to the workflow's cleanup intent. |
| `commitBundle()` | `runtime.commit()` or `runtime.commit({ batch })`. Provider code no longer owns the cross-resource workflow commit. |

First migration wave expectations:

| Provider family | `beginTransaction` | `bundleEvents` |
|---|---|---|
| D1 / Cloudflare Worker SQL | Optional. Declare only if the implementation exposes a real transaction handle; otherwise runtime commit is best-effort ordered writes. | Required for telemetry-capable D1 paths. |
| Postgres / Kysely / Drizzle / Prisma | Required when backed by a transactional SQL client. | Required. |
| Supabase | Optional. Declare only if the implementation can execute the whole commit inside one real transaction, for example via a transaction RPC/client. | Required. |
| MongoDB | Optional. Declare when the deployment supports sessions/transactions; otherwise runtime commit is best-effort ordered writes. | Optional in the first wave unless a `bundle_events` collection is added. |
| Firebase / Firestore | Optional. Declare only if all touched resources can participate in the same transaction/batch. | Optional in the first wave unless a `bundle_events` collection is added. |
| S3 / blob-backed database | Omitted. | Omitted. |
| Standalone HTTP repository | Mirrors the remote provider. It must preserve the existing HTTP route contract while translating payloads to v2 batches. | Mirrors the remote provider. |

These expectations are migration gates, not long-term capability flags. Future
providers still declare only the resources and transaction hook they actually
implement.

## `createDatabasePlugin` Helper

`createDatabasePlugin` is the provider-author helper. It should preserve the
spec shape and return the public plugin entry point that Hot Updater config uses.
The helper owns spec validation, lazy connection, and hook wiring; provider
authors only supply the current spec. The provider-authored core has
resource-local primitive write methods; the returned runtime has one public
commit.

```ts
export interface DatabasePluginCreator {
  readonly name: string;

  (config: unknown): MaybePromise<DatabasePluginRuntime>;
}

export function createDatabasePlugin(
  spec: DatabasePluginSpec,
): DatabasePluginCreator;
```

The TypeScript implementation can infer a concrete config type from
`connect(config)`, but provider docs and examples must not require explicit
generic arguments.

Provider example:

This is intentionally written inline so the provider implementation shape is
visible. Real providers can still extract row mappers and cursor query builders
after the core shape is clear.

```ts
export interface D1DatabaseConfig {
  readonly database: D1Database;
}

export const d1Database = createDatabasePlugin({
  name: "d1Database",

  connect(config: D1DatabaseConfig) {
    const { database } = config;
    const runBatch = async (statements: readonly D1PreparedStatement[]) => {
      if (statements.length > 0) {
        await database.batch([...statements]);
      }
    };

    return {
      bundles: {
        async getById({ bundleId }) {
          const row = await database
            .prepare("SELECT * FROM bundles WHERE id = ? LIMIT 1")
            .bind(bundleId)
            .first<BundleRow>();

          return row ? toBundleRecord(row) : null;
        },

        async list(params) {
          const page = toD1CursorQuery("bundles", params, {
            defaultOrderBy: { field: "id", direction: "desc" },
          });
          const { results } = await database
            .prepare(page.sql)
            .bind(...page.params)
            .all<BundleRow>();

          return toCursorPage(results.map(toBundleRecord), page);
        },

        async insert({ bundle }) {
          await database
            .prepare(
              `INSERT INTO bundles (
                id,
                platform,
                channel,
                enabled,
                should_force_update,
                file_hash,
                storage_uri,
                target_app_version,
                fingerprint_hash,
                metadata
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(...toBundleInsertValues(bundle))
            .run();
        },

        async update({ bundleId, patch }) {
          const update = toBundleUpdateStatement(bundleId, patch);
          await database.prepare(update.sql).bind(...update.params).run();
        },

        async delete({ bundleId }) {
          await database
            .prepare("DELETE FROM bundles WHERE id = ?")
            .bind(bundleId)
            .run();
        },
      },

      bundlePatches: {
        async list(params) {
          const page = toD1CursorQuery("bundle_patches", params, {
            defaultOrderBy: { field: "orderIndex", direction: "asc" },
          });
          const { results } = await database
            .prepare(page.sql)
            .bind(...page.params)
            .all<BundlePatchRow>();

          return toCursorPage(results.map(toBundlePatch), page);
        },

        async replaceForBundle({ bundleId, patches }) {
          await runBatch([
            database
              .prepare("DELETE FROM bundle_patches WHERE bundle_id = ?")
              .bind(bundleId),
            ...patches.map((patch) =>
              database
                .prepare(
                  `INSERT INTO bundle_patches (
                    id,
                    bundle_id,
                    base_bundle_id,
                    base_file_hash,
                    patch_file_hash,
                    patch_storage_uri,
                    order_index
                  ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(...toBundlePatchInsertValues(patch)),
            ),
          ]);
        },

        async deleteForBundle({ bundleId }) {
          await database
            .prepare("DELETE FROM bundle_patches WHERE bundle_id = ?")
            .bind(bundleId)
            .run();
        },

        async deleteForBaseBundle({ baseBundleId }) {
          await database
            .prepare("DELETE FROM bundle_patches WHERE base_bundle_id = ?")
            .bind(baseBundleId)
            .run();
        },
      },

      bundleEvents: {
        async list(params) {
          const page = toD1CursorQuery("bundle_events", params, {
            defaultOrderBy: { field: "id", direction: "desc" },
          });
          const { results } = await database
            .prepare(page.sql)
            .bind(...page.params)
            .all<BundleEventRow>();

          return toCursorPage(results.map(toBundleEvent), page);
        },

        async append({ event }) {
          await database
            .prepare(
              `INSERT INTO bundle_events (
                id,
                kind,
                install_id,
                active_bundle_id,
                previous_active_bundle_id,
                crashed_bundle_id,
                platform,
                channel,
                app_version,
                fingerprint_hash,
                cohort,
                payload
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(...toBundleEventInsertValues(event))
            .run();
        },
      },
    };
  },
});
```

Provider without `bundleEvents`:

```ts
export const s3Database = createDatabasePlugin({
  name: "s3Database",

  connect(config: S3DatabaseConfig) {
    return {
      bundles: createS3BundleResource(config),
      bundlePatches: createS3BundlePatchResource(config),
    };
  },
});
```

Because `bundleEvents` is omitted, the returned runtime type exposes no
`database.bundleEvents` field for `s3Database`.

Config usage:

```ts
import { env } from "cloudflare:workers";

export default {
  database: d1Database({
    database: env.HOT_UPDATER_D1,
  }),
};
```

This usage belongs in a Worker-only module. Node-based deploy, console, and
database setup flows must keep using explicit provider configuration instead of
importing `cloudflare:workers`.

## Runtime Usage

```ts
const database = await d1Database(config);

await database.bundles.insert({ bundle });
await database.bundlePatches.replaceForBundle({
  bundleId: bundle.id,
  patches,
});
if (database.bundleEvents) {
  await database.bundleEvents.append({ event });
}

// Reads from the instance identity map before provider writes run.
const stagedBundle = await database.bundles.getById({ bundleId: bundle.id });

await database.commit();

await database.close?.();
```

## Design Decisions

- `factory` is replaced with `connect` because v2 needs an explicit runtime
  lifecycle, not just object construction.
- There is no plugin `version` discriminator in the provider-facing spec. This
  rewrite is a breaking contract change.
- Database setup is not part of the provider-facing runtime object.
- The schema is embedded in `createDatabasePlugin`; provider specs do not pass
  or expose schema.
- `createDatabasePlugin` owns the instance identity map and staged mutation
  overlay.
- Provider code implements resource primitive write methods only; it does not
  implement read-your-writes behavior.
- `createHotUpdater` request paths should use one database runtime instance per
  request so the identity map is request-scoped; this means a runtime wrapper
  scope, not a fresh provider connection.
- No `capabilities` block in the base spec.
- Cursor pagination is mandatory.
- Bundle patches are mandatory and separate from bundle writes.
- Bundle events are optional by declaration: implement `bundleEvents` to support
  telemetry, omit it to remove the runtime `bundleEvents` resource for that
  provider.
- `s3Database` intentionally omits `bundleEvents`.
- When present, `bundle_events` is the source-of-truth event log; Active,
  Recovered, and transition counts are derived read models.
- Transactions are expressed by `beginTransaction`, not by metadata.
- Providers without `beginTransaction` run best-effort ordered writes; partial
  durability on failure is possible.
- `updateInfo` is optional because it is an optimization/fast path.
- Deprecated inline bundle patch fields are not part of the v2 write model.
