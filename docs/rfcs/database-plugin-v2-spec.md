# Database Plugin v2 Spec Draft

## Goals

`createDatabasePlugin` v2 defines a resource-oriented database contract for
Hot Updater while keeping the provider-authored core small and predictable.

The v2 contract treats these as baseline database features:

- bundles
- bundle patches
- bundle events as an append-only event sourcing log
- cursor pagination for list queries

Transaction support is not modeled as a capability flag. Providers that can
open an explicit transaction expose `beginTransaction`.

`bundle_events` is not a summary table. It is the source-of-truth event log for
client telemetry reported by installed apps. Counts such as Active, Recovered,
and bundle transitions are read models derived from this append-only log.

## Migration Acceptance Criteria

The implementation PR for this spec is complete only when all of these gates
are satisfied:

- Every `createDatabasePlugin` call site is migrated to the v2 surface.
- Deploy, console, and `createHotUpdater` paths are updated for the new runtime
  shape.
- `bundle_patches` remains a first-class resource and is not hidden inside
  bundle-only writes.
- `bundle_events` is added as the append-only event sourcing resource for client
  telemetry.
- All standalone verification profiles pass through `hot-updater-agent`:
  `standalone-s3`, `standalone-drizzle`, `standalone-prisma`,
  `standalone-kysely`, and `standalone-mongodb`.
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

export interface DatabasePluginSpec<
  TConfig,
  TContext = unknown,
  TTx = unknown,
> {
  readonly name: string;
  readonly connect: (
    config: TConfig,
  ) => MaybePromise<DatabasePluginCore<TContext, TTx>>;
}
```

## Plugin Core Contract

`connect` returns the provider-authored database core directly. There is no
`adapter` wrapper and no setup lifecycle in the provider-facing runtime object.

```ts
export interface DatabasePluginCore<TContext = unknown, TTx = unknown> {
  readonly beginTransaction?: (
    context?: HotUpdaterContext<TContext>,
  ) => Promise<DatabaseTransaction<TTx>>;

  readonly bundles: BundleResource<TContext, TTx>;
  readonly bundlePatches: BundlePatchResource<TContext, TTx>;
  readonly bundleEvents: BundleEventResource<TContext, TTx>;
  readonly updateInfo?: UpdateInfoRepository<TContext, TTx>;

  readonly close?: () => Promise<void>;
}

export interface DatabasePluginRuntime<TContext = unknown, TTx = unknown> {
  readonly beginTransaction?: (
    context?: HotUpdaterContext<TContext>,
  ) => Promise<DatabaseTransaction<TTx>>;

  readonly bundles: RuntimeBundleRepository<TContext, TTx>;
  readonly bundlePatches: RuntimeBundlePatchRepository<TContext, TTx>;
  readonly bundleEvents: RuntimeBundleEventRepository<TContext, TTx>;
  readonly updateInfo?: UpdateInfoRepository<TContext, TTx>;

  readonly commit: (
    batch?: DatabaseCommitBatch,
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<void>;

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
  `bundleEvents`, and optional `updateInfo`.
- Basic features are required by shape, not described by `capabilities` flags.
- Runtime writes enter through resource staging methods; `commit()` or
  `commit(batch)` is the public flush boundary.
- Provider write implementations are co-located with each resource repository.
- Runtime resource write methods stage mutations into an instance identity map;
  provider resource `apply` methods persist them.
- Reads are read-your-writes inside the same runtime instance.
- A mutation says what changed, not how a provider should execute it.
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
- Bundle patches or bundle events are hidden behind bundle-only methods.
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
- Runtime `commit` is declarative at the boundary because it receives mutation
  data.
- Provider write code is easier to maintain when each resource owns its own
  `apply` implementation.
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
- Provider core `apply` methods persist staged mutations; provider code does not
  implement identity map behavior.
- A staged `bundle.insert` must be visible through `runtime.bundles.getById`
  before runtime `commit` calls `core.bundles.apply`.
- Staged bundle updates must read as merged bundle records before apply.
- Staged bundle deletes must read as `null` before apply.
- `list` methods overlay staged records onto provider results before returning.
- Successful runtime `commit` clears staged entries that were applied.
- Failed runtime `commit` keeps staged entries so the caller can retry or surface
  the failure with the same in-memory view.

This matters for `createHotUpdater`:

- `createHotUpdater` should create a database runtime instance per request for
  request-driven server paths.
- The request handler should reuse that same runtime instance for every read and
  write inside the request.
- CLI flows such as deploy, rollback, promote, and console actions may use one
  command/action-scoped runtime instance.
- Cross-request identity maps are not allowed; persistent cross-request caching
  belongs in provider code or an explicit cache layer, not in the runtime
  identity map.

Example read-your-writes flow:

```ts
const database = await d1Database(config);

await database.bundles.insert(bundle);

// Reads from the identity map even though core.bundles.apply has not run yet.
const staged = await database.bundles.getById(bundle.id);

await database.commit();
```

## Transaction Boundary Decision

Use this decision rule when choosing between one top-level commit and
resource-local write handlers:

- Keep one public runtime `commit(batch?)` because runtime commit is the
  transaction boundary over staged mutations.
- Keep provider-authored writes co-located as resource-local `apply` methods.
- Do not name resource-local methods `commit`; that collides with SQL providers
  where `COMMIT;` is the transaction finalization step.
- For PostgreSQL, `BEGIN`, `COMMIT`, and `ROLLBACK` belong to
  `beginTransaction` or the `createDatabasePlugin` runtime commit wrapper.
- Resource `apply` methods receive the transaction handle through
  `DatabaseOperationContext` and execute only their own mutations.
- `createDatabasePlugin` owns grouping, ordering, transaction finalization, and
  hook execution.
- Resource `apply` methods own SQL/document/blob statements for their resource
  only.

Recommended layering:

```ts
await runtime.commit(); // or runtime.commit(batch)

// createDatabasePlugin:
// 1. stage the provided batch if commit(batch) was called
// 2. snapshot staged mutations from the identity map
// 3. open transaction if the provider exposes one
// 4. group mutations by resource
// 5. call core.bundles.apply(bundleMutations, txContext)
// 6. call core.bundlePatches.apply(bundlePatchMutations, txContext)
// 7. call core.bundleEvents.apply(bundleEventMutations, txContext)
// 8. call tx.commit() once, or tx.rollback() once on failure
// 9. clear the applied staged mutations after success
```

PostgreSQL sketch:

```ts
connect({ pool }) {
  return {
    async beginTransaction() {
      const client = await pool.connect();
      await client.query("BEGIN");

      return {
        handle: client,
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
      async getById(bundleId, context) {
        const db = context?.transaction?.handle ?? pool;
        const result = await db.query("SELECT * FROM bundles WHERE id = $1", [
          bundleId,
        ]);

        return result.rows[0] ? toBundleRecord(result.rows[0]) : null;
      },

      async apply(mutations, context) {
        const db = context?.transaction?.handle ?? pool;

        for (const mutation of mutations) {
          // Run only bundle SQL here.
          await applyBundleMutation(db, mutation);
        }
      },
    },

    bundlePatches: {
      async list(query, context) {
        const db = context?.transaction?.handle ?? pool;
        return listBundlePatches(db, query);
      },

      async apply(mutations, context) {
        const db = context?.transaction?.handle ?? pool;

        for (const mutation of mutations) {
          // Run only bundle patch SQL here.
          await applyBundlePatchMutation(db, mutation);
        }
      },
    },

    bundleEvents: {
      async list(query, context) {
        const db = context?.transaction?.handle ?? pool;
        return listBundleEvents(db, query);
      },

      async apply(mutations, context) {
        const db = context?.transaction?.handle ?? pool;

        for (const mutation of mutations) {
          // Run only bundle event SQL here.
          await applyBundleEventMutation(db, mutation);
        }
      },
    },
  };
}
```

## Transaction Model

```ts
export interface DatabaseTransaction<TTx = unknown> {
  readonly handle: TTx;
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}

export interface DatabaseOperationContext<TContext = unknown, TTx = unknown> {
  readonly request?: HotUpdaterContext<TContext>;
  readonly transaction?: DatabaseTransaction<TTx>;
}
```

Transaction semantics:

- `beginTransaction` is optional.
- If a transaction is provided to repository methods or resource `apply`
  methods, the core must execute inside that transaction.
- Resource `apply` methods never call `transaction.commit()` or
  `transaction.rollback()`.
- If `createDatabasePlugin` opens a transaction for runtime `commit`, it owns
  `transaction.commit()` and `transaction.rollback()`.
- If the caller passes an existing transaction into runtime `commit`,
  `createDatabasePlugin` uses it but does not finalize it.
- Providers without explicit transactions run resource `apply` methods as an
  ordered write sequence and surface any failure.

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
export interface RuntimeBundleRepository<TContext = unknown, TTx = unknown>
  extends BundleRepository<TContext, TTx> {
  readonly insert: (
    bundle: DatabaseBundleRecord,
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<void>;

  readonly update: (
    bundleId: string,
    patch: Partial<DatabaseBundleRecord>,
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<void>;

  readonly delete: (
    bundleId: string,
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<void>;
}

export interface BundleResource<TContext = unknown, TTx = unknown>
  extends BundleRepository<TContext, TTx> {
  readonly apply: (
    mutations: readonly BundleMutation[],
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<void>;
}

export interface BundleRepository<TContext = unknown, TTx = unknown> {
  readonly getById: (
    bundleId: string,
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<DatabaseBundleRecord | null>;

  readonly list: (
    query: BundleListQuery,
    context?: DatabaseOperationContext<TContext, TTx>,
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
export interface RuntimeBundlePatchRepository<
  TContext = unknown,
  TTx = unknown,
> extends BundlePatchRepository<TContext, TTx> {
  readonly replaceForBundle: (
    bundleId: string,
    patches: readonly DatabaseBundlePatch[],
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<void>;

  readonly deleteForBundle: (
    bundleId: string,
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<void>;

  readonly deleteForBaseBundle: (
    baseBundleId: string,
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<void>;
}

export interface BundlePatchResource<TContext = unknown, TTx = unknown>
  extends BundlePatchRepository<TContext, TTx> {
  readonly apply: (
    mutations: readonly BundlePatchMutation[],
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<void>;
}

export interface BundlePatchRepository<TContext = unknown, TTx = unknown> {
  readonly list: (
    query: BundlePatchListQuery,
    context?: DatabaseOperationContext<TContext, TTx>,
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

Bundle events are a required v2 resource backed by the `bundle_events` table.
Providers must support appending events through resource-local `apply`.

The table is append-only. Providers should not update or delete bundle events as
part of normal Hot Updater workflows. Event summaries are derived read models,
not provider-authored source-of-truth APIs.

```ts
export interface RuntimeBundleEventRepository<
  TContext = unknown,
  TTx = unknown,
> extends BundleEventRepository<TContext, TTx> {
  readonly append: (
    event: DatabaseBundleEventInput,
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<void>;
}

export interface BundleEventResource<TContext = unknown, TTx = unknown>
  extends BundleEventRepository<TContext, TTx> {
  readonly apply: (
    mutations: readonly BundleEventMutation[],
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<void>;
}

export interface BundleEventRepository<TContext = unknown, TTx = unknown> {
  readonly list: (
    query: BundleEventListQuery,
    context?: DatabaseOperationContext<TContext, TTx>,
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
export interface UpdateInfoRepository<TContext = unknown, TTx = unknown> {
  readonly get: (
    args: GetBundlesArgs,
    context?: DatabaseOperationContext<TContext, TTx>,
  ) => Promise<UpdateInfo | null>;
}
```

## Commit Batch

Runtime staged writes flush through one public `commit`. Provider
implementations are resource-local: `createDatabasePlugin` groups mutations by
kind and delegates each group to the matching resource `apply`.

```ts
export interface DatabaseCommitBatch {
  readonly mutations: readonly DatabaseMutation[];
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

- `createDatabasePlugin` exposes one public `commit(batch?, context)` method.
- Runtime resource methods such as `bundles.insert` and
  `bundlePatches.replaceForBundle` stage mutations in the identity map.
- Calling `commit()` applies the currently staged mutations.
- Calling `commit(batch)` stages the provided batch first, then applies the
  staged mutations.
- `createDatabasePlugin` invokes only the resource `apply` methods required by the
  current batch.
- Resource `apply` methods receive only their own mutation types.
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
- `bundleEvents.append` accepts event input without an id; runtime generates a
  UUIDv7 id before staging the mutation.
- `bundleEvent.append` appends one server-enriched bundle event to the
  append-only `bundle_events` log.

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
    readonly bundleEvents: "bundle_events";
  };
}
```

Required storage resources:

- `bundles`
- `bundle_patches`
- `bundle_events`

## `createDatabasePlugin` Helper

`createDatabasePlugin` is the provider-author helper. It should preserve the
spec shape and return the public plugin entry point that Hot Updater config uses.
The helper owns spec validation, lazy connection, and hook wiring; provider
authors only supply the current spec. The provider-authored core has
resource-local apply methods; the returned runtime has one public commit.

```ts
export interface DatabasePluginCreator<
  TConfig,
  TContext = unknown,
  TTx = unknown,
> {
  readonly name: string;

  (
    config: TConfig,
  ): MaybePromise<DatabasePluginRuntime<TContext, TTx>>;
}

export function createDatabasePlugin<
  TConfig,
  TContext = unknown,
  TTx = unknown,
>(
  spec: DatabasePluginSpec<TConfig, TContext, TTx>,
): DatabasePluginCreator<TConfig, TContext, TTx>;
```

Provider example:

This is intentionally written inline so the provider implementation shape is
visible. Real providers can still extract row mappers and cursor query builders
after the core shape is clear.

```ts
export interface D1DatabaseConfig {
  readonly database: D1Database;
}

export const d1Database = createDatabasePlugin<D1DatabaseConfig>({
  name: "d1Database",

  connect({ database }) {
    const runBatch = async (statements: readonly D1PreparedStatement[]) => {
      if (statements.length > 0) {
        await database.batch([...statements]);
      }
    };

    return {
      bundles: {
        async getById(bundleId) {
          const row = await database
            .prepare("SELECT * FROM bundles WHERE id = ? LIMIT 1")
            .bind(bundleId)
            .first<BundleRow>();

          return row ? toBundleRecord(row) : null;
        },

        async list(query) {
          const page = toD1CursorQuery("bundles", query, {
            defaultOrderBy: { field: "id", direction: "desc" },
          });
          const { results } = await database
            .prepare(page.sql)
            .bind(...page.params)
            .all<BundleRow>();

          return toCursorPage(results.map(toBundleRecord), page);
        },

        async apply(mutations) {
          const statements: D1PreparedStatement[] = [];

          for (const mutation of mutations) {
            switch (mutation.kind) {
              case "bundle.insert":
                statements.push(
                  database
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
                    .bind(...toBundleInsertValues(mutation.bundle)),
                );
                break;

              case "bundle.update": {
                const update = toBundleUpdateStatement(
                  mutation.bundleId,
                  mutation.patch,
                );
                statements.push(
                  database.prepare(update.sql).bind(...update.params),
                );
                break;
              }

              case "bundle.delete":
                statements.push(
                  database
                    .prepare("DELETE FROM bundles WHERE id = ?")
                    .bind(mutation.bundleId),
                );
                break;
            }
          }

          await runBatch(statements);
        },
      },

      bundlePatches: {
        async list(query) {
          const page = toD1CursorQuery("bundle_patches", query, {
            defaultOrderBy: { field: "orderIndex", direction: "asc" },
          });
          const { results } = await database
            .prepare(page.sql)
            .bind(...page.params)
            .all<BundlePatchRow>();

          return toCursorPage(results.map(toBundlePatch), page);
        },

        async apply(mutations) {
          const statements: D1PreparedStatement[] = [];

          for (const mutation of mutations) {
            switch (mutation.kind) {
              case "bundlePatch.replaceForBundle":
                statements.push(
                  database
                    .prepare("DELETE FROM bundle_patches WHERE bundle_id = ?")
                    .bind(mutation.bundleId),
                  ...mutation.patches.map((patch) =>
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
                );
                break;

              case "bundlePatch.deleteForBundle":
                statements.push(
                  database
                    .prepare(
                      "DELETE FROM bundle_patches WHERE bundle_id = ?",
                    )
                    .bind(mutation.bundleId),
                );
                break;

              case "bundlePatch.deleteForBaseBundle":
                statements.push(
                  database
                    .prepare(
                      "DELETE FROM bundle_patches WHERE base_bundle_id = ?",
                    )
                    .bind(mutation.baseBundleId),
                );
                break;
            }
          }

          await runBatch(statements);
        },
      },

      bundleEvents: {
        async list(query) {
          const page = toD1CursorQuery("bundle_events", query, {
            defaultOrderBy: { field: "id", direction: "desc" },
          });
          const { results } = await database
            .prepare(page.sql)
            .bind(...page.params)
            .all<BundleEventRow>();

          return toCursorPage(results.map(toBundleEvent), page);
        },

        async apply(mutations) {
          const statements = mutations.map((mutation) =>
            database
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
              .bind(...toBundleEventInsertValues(mutation.event)),
          );

          await runBatch(statements);
        },
      },
    };
  },
});
```

Config usage:

```ts
export default {
  database: d1Database({
    database: env.HOT_UPDATER_D1,
  }),
};
```

## Runtime Usage

```ts
const database = await d1Database(config);

await database.bundles.insert(bundle);
await database.bundlePatches.replaceForBundle(bundle.id, patches);
await database.bundleEvents.append(event);

// Reads from the instance identity map before provider apply runs.
const stagedBundle = await database.bundles.getById(bundle.id);

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
- Provider code implements resource `apply` methods only; it does not implement
  read-your-writes behavior.
- `createHotUpdater` request paths should use one database runtime instance per
  request so the identity map is request-scoped.
- No `capabilities` block in the base spec.
- Cursor pagination is mandatory.
- Bundle patches are mandatory and separate from bundle writes.
- Bundle events are mandatory as an append-only event sourcing resource.
- `bundle_events` is the source-of-truth event log; Active, Recovered, and
  transition counts are derived read models.
- Transactions are expressed by `beginTransaction`, not by metadata.
- `updateInfo` is optional because it is an optimization/fast path.
- Deprecated inline bundle patch fields are not part of the v2 write model.
