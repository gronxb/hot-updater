# Database Plugin API Spec

## Unit of Work boundary

Database mutations are staged by plugin-core and flushed through one root commit
boundary. Table operations stage logical row changes; they do not commit durable
state themselves.

## Runtime database API

A configured `DatabasePlugin` exposes table operations for reads and staging:

- `database.bundles.get(context, { id })`
- `database.bundles.list(context, input)`
- `database.bundles.append(context, { data })`
- `database.bundles.update(context, { id, data })`
- `database.channels.getChannels(...)`
- `database.analytics.*` when enabled
- `database.bundlePatches?.append(context, { data })` when the provider declares
  `bundlePatches` change-bucket support
- `database.analyticsEvents?.append(context, { data })` when the provider
  declares `analyticsEvents` change-bucket support
- `database.ingestKeys?.append(context, { data })` and
  `database.ingestKeys?.update(context, { id, data })` when the provider
  declares `ingestKeys` change-bucket support
- `database.updates.check(context, input)` when an update-check fast path is
  supported

The only durable mutation boundary is root-level:

```ts
method(context, inputObject);
```

`commit` receives the optional request context and flushes every staged change in
that logical operation. `commit` is not a bundle-table method, and plugin-core
must not expose any table-local commit method.
There is no public `begin`; request-scoped Unit of Work state is created by
plugin-core when operations are invoked with a context. CLI-style no-context
flows may still stage changes until the root `commit(context, {})` call.

Bundle deletion is intentionally not a public table verb. Shared deletion flows
use `deleteBundleById(database, context, { id, bundle? })`, which stages bundle
cleanup through the same root commit boundary. Providers that declare
`bundlePatches` support also receive explicit bundle-patch delete changes;
otherwise their bundle-delete commit path remains responsible for cleaning
related patch rows or manifests.

## Provider factory API

Provider factories return durable read methods grouped by table plus a root
flush method:

```ts
provider.supportedChangeBuckets?: readonly DatabaseChangeBucket[];
database.bundles.get(context, { id });
database.bundles.list(context, options);
database.updates?.check(context, input);
database.channels.getChannels(context);
database.commit(context, { changes });
```

Plugin-core owns public staging methods and converts them into grouped root
changes. `bundles` is always supported. Optional table namespaces are exposed
only when the provider declares the matching `supportedChangeBuckets` entry.
If an unsupported non-empty bucket reaches root commit, plugin-core throws
before calling the provider and preserves the staged Unit of Work state.

```ts
database.bundles.append(context, { data });
database.bundles.update(context, { id, data });
database.bundlePatches?.append(context, { data });
database.analyticsEvents?.append(context, { data });
database.ingestKeys?.append(context, { data });
database.ingestKeys?.update(context, { id, data });
database.commit(context, {});
```

`changes` is a grouped `DatabaseChanges` payload derived by plugin-core from all
staged table operations in the current Unit of Work. It has first-class buckets
for `bundles`, `bundlePatches`, `analyticsEvents`, and `ingestKeys`.

## Non-table fast paths

`updates.check` remains the only planned non-table provider exception. It is a
read-only update-check fast path; it does not stage or commit changes.

```ts
providerDatabase.bundles.get(context, input);
providerDatabase.bundles.list(context, input);
providerDatabase.commit(context, { changes });
```

Providers should flush `DatabaseChanges` with the strongest atomicity their
backing store supports. Providers without a cross-table transaction primitive
must document that their root commit is an ordered best-effort flush.

### Provider Atomicity Guarantees

Provider root commits consume grouped `DatabaseChanges`. Providers that still
derive patch rows from bundle rows may primarily use `changes.bundles`, while
providers with first-class tables can flush `bundlePatches`, `analyticsEvents`,
and `ingestKeys` through the same root boundary.

| Provider surface | Root commit guarantee |
| --- | --- |
| `plugins/postgres` | Single Kysely transaction across bundle and bundle patch rows. |
| `packages/server` Kysely adapter | Single Kysely transaction across bundle and bundle patch rows. |
| `plugins/firebase` | Single Firestore transaction across bundle, target version, and channel documents. |
| `packages/server` Drizzle adapter | Uses `db.transaction` when the Drizzle client exposes it; otherwise ordered best-effort flush. |
| `packages/server` Prisma adapter | Uses `$transaction` when the Prisma client exposes it; otherwise ordered best-effort flush. |
| `packages/server` MongoDB adapter | Uses a MongoDB session transaction when supported; falls back to ordered best-effort when transactions are unavailable. |
| `plugins/supabase` | Ordered Supabase REST writes; no cross-table rollback guarantee. |
| `plugins/cloudflare` D1 REST adapter | Ordered D1 REST queries; no cross-query rollback guarantee. |
| `plugins/cloudflare` Worker D1 adapter | Ordered Worker D1 statements; no cross-statement rollback guarantee. |
| Blob-backed providers (`createBlobDatabasePlugin`, AWS/S3) | Ordered object writes and deletes; no cross-object rollback guarantee. |
| `plugins/standalone` | Ordered HTTP route calls; atomicity depends on the remote server implementation. |
| `plugins/mock` | In-memory ordered mutation, intended for tests and local development only. |
