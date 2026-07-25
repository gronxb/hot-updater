# Hot Updater Server Plugin Kernel

## Status

- Status: Accepted; implementation in verification
- Last updated: 2026-07-25
- Scope: `@hot-updater/server`, server feature plugins, provider
  capabilities, managed runtimes, and standalone forwarding
- Target release: after the current database-plugin-v2 and Analytics release
  cohort

## Consensus record

The final document was reviewed against the same revision by six independent
roles:

| Role                                     | Final verdict |
| ---------------------------------------- | ------------- |
| Requirements and traceability            | PASS          |
| Architecture proponent                   | PASS          |
| Architecture opponent                    | PASS          |
| Hot Updater plugin maintainer            | PASS          |
| Security architect                       | PASS          |
| Independent capability-contract mediator | PASS          |

An implementation review with kernel ownership, compatibility, provider,
consumer, security, and architecture-opponent personas superseded the original
missing-provider proposal. Following the Better Auth API Key precedent, a
feature consumes the generic adapter but the adapter does not install the
feature. Analytics therefore receives the frozen guarded database runtime
directly, always constructs an available feature, and accepts an explicit
provider factory for dedicated transports. Standalone uses a separate
`standaloneAnalytics(config)` manifest. No unresolved blocker remains in this
design.

### Implementation consensus addendum

The implementation-planning review resolved the following details. These
clarifications are normative where they narrow or repair the original prose:

- **R1 — Node adapter stage:** generic lazy raw-body forwarding and request
  policies in `@hot-updater/server/node` are Stage 1. Stage 2 retains downstream
  framework adoption. An already parsed protected body is unsupported.
- **R2 — plugin-core cleanup:** its public high-level Analytics service,
  domain, support boolean, and token leave in Stage 1. Only the internal raw
  persistence model may remain until its Stage 3 ownership decision.
- **R3 — manifest branding:** first-party packages use the unsupported non-root
  `@hot-updater/server/internal/first-party-plugin` subpath. The brand remains
  private and the supported root exposes no authoring factory.
- **R4 — capability ownership:** plugin-core owns nominal tokens, authoring,
  immutable carrier attachment, and a narrow internal enumeration seam. Server
  owns guarded materialization and the read-only registry.
- **R5 — guarded persistence:** database-backed factories receive a frozen
  CRUD/transaction-only `DatabaseCapabilityRuntime`; each operation enters the
  existing readiness guard. No raw database or infrastructure escape is
  exposed.
- **R6 — type projection:** omitted plugins infer an exact empty feature
  object. A private `FeatureApiKind` applies `TContext` and preserves the
  available-with-aliases versus unavailable-without-aliases correlation.
- **R7 — Analytics metadata scope:** compatibility applies when `analytics()`
  or the bridge is installed. Omission contributes no keys or warning;
  warn-mode absence contributes only the three false keys; AWS/blob omit it.
- **R8 — metadata bounds:** resolvers run concurrently under one five-second
  deadline and kernel-owned `AbortSignal`. Limits are 16 KiB UTF-8 per
  contribution and 64 KiB aggregate. Validation is atomic; failure yields one
  opaque `500` with no partial metadata.
- **R9 — principal validation:** copy an exact frozen two-field object.
  `subject` and `issuer` are primitive, well-formed, already-trimmed, non-empty
  Unicode without C0/DEL controls, capped at 1,024 and 2,048 UTF-8 bytes. No
  normalization, case folding, or issuer-URL rule applies.
- **R10 — Better Auth outages:** provider-classified `anonymous`,
  `unavailable`, and unexpected/malformed results map to opaque `401`, `503`,
  and `500`. Better Auth `null` is anonymous; a swallowed outage remains
  fail-closed as `401`. In locked Better Auth 1.6.24, a session-store `503` is
  surfaced as an `INTERNAL_SERVER_ERROR`/`500` with its original
  classification erased, so it correctly follows the unexpected-error
  branch. Better Auth's own default logger observes the original store error
  before that rewrite; deployments requiring strict log secrecy must disable
  or sanitize that dependency logger. Neither upstream limitation is a claimed
  exact-`503` case or a Hot Updater logging path.
- **R11 — capability conflicts:** token-ID and provider duplication are
  distinct, checked in that order, and use
  `DUPLICATE_CAPABILITY_TOKEN_ID` and `DUPLICATE_CAPABILITY_PROVIDER`.
  Compilation uses stable lexical identities.
- **R12 — Analytics/transport ownership:** Analytics owns operation, parsing,
  provider selection, metadata, API, and bridge semantics. The standalone
  companion owns its dedicated guarded transport and probe/cache behavior.
  Database plugins own neither.
- **R13 — legacy bridge:** `@hot-updater/analytics/legacy-server` exports
  exactly `createLegacyHotUpdater` and `LegacyCreateHotUpdaterOptions`. Only
  that option type recognizes `routes.analytics`; it never adds
  `routes.eventIngestion`.
- **R14 — declarations:** every new or changed dual-format entry publishes
  condition-specific `.d.mts` and `.d.cts` declarations verified from a real
  packed tarball. Package runtime maps remain condition-specific. CLI config
  evaluation instead uses a serialized, temporary canonical module cohort for
  plugin-core root/internal capability APIs, Analytics root, and the server's
  private first-party manifest authoring entry, then restores the CommonJS
  cache on success or failure. Every future nominal package surface usable from
  config must join this cohort and add a mixed CommonJS config-to-ESM runtime
  composition gate, or replace the bridge with an equivalent identity
  substrate.
- **R15 — route options:** `HandlerOptions.routes` is the sole public route
  selector and its named value type is `HandlerRoutes`. `coreRoutes` remains an
  internal implementation name only and is not accepted by either public
  handler entrypoint.
- **R16 — monotonic protection:** a first-party manifest may contribute only
  `routePolicy: { kind: "protect-all" }`. The composer applies this policy
  after collecting every core and feature route, changing public access to
  protected access without ever changing protected access back to public.
- **R17 — Better Auth adaptation:** `betterAuthPlugin({ auth })` authenticates
  through `auth.api.getSession` and contributes protect-all. Applications that
  need API keys configure Better Auth's `@better-auth/api-key` plugin with
  `enableSessionForAPIKeys: true`; Hot Updater has no separate API-key mode.
  Managed runtimes use `managedBetterAuthPlugin({ apiKeySha256 })` from
  `@hot-updater/better-auth/managed`, which projects one provisioned digest
  into the same Better Auth session contract.
- **R18 — managed matrix:** AWS, Cloudflare, Firebase, and Supabase install the
  managed Better Auth plugin by default. Every route actually mounted by each
  managed handler is protected. Cloudflare, Firebase, and Supabase also
  install Analytics; AWS does not.
- **R19 — managed provisioning and caching:** provisioning writes the raw
  `HOT_UPDATER_API_KEY` only to a local environment file and injects only
  `HotUpdater.API_KEY_SHA256` into the deployed runtime. AWS disables caching
  for the handler behavior and protected responses use `no-store`; a CDN must
  never serve an authenticated handler response without re-authentication.

## Decision summary

`createHotUpdater` becomes a setup-time plugin composer. It knows only the
following kernel concepts:

- configured database and storage infrastructure;
- validated capability tokens;
- route manifests;
- route access requirements;
- fixed request middleware phases;
- namespaced runtime metadata;
- construction-time conflict detection.

The new plugin-based `createHotUpdater` entrypoint does not know Analytics
domain concepts from its first release. `@hot-updater/server` must contain no
Analytics imports, event or installation types, Analytics route literals,
Analytics capability keys, or Analytics-specific request limits. A temporary
source-compatibility bridge, when needed, lives under
`@hot-updater/analytics/legacy-server`; it is not imported by the server
package.

Installing `analytics()` is the only feature-level operation that enables
Analytics. The feature owns its provider selection: it uses the guarded generic
database runtime by default and may receive an explicit provider factory for a
dedicated transport. Database plugins never install or advertise Analytics.

Authentication is a mechanism-neutral kernel concept. A configured
authentication plugin gates protected routes before their bodies or handlers
are evaluated. The kernel does not know API-key headers, hashing, Better Auth,
or credential storage. Authentication manifests may, however, declare the
single monotonic protect-all route policy. Better Auth is the concrete
first-party mechanism built on that generic contract; its managed subpath
supplies the digest-backed preset.

The first version keeps update check, bundle management, and `/version` as core
Hot Updater protocol surfaces. It extracts optional cross-cutting features
without turning the kernel into a general application framework.

## Reference model: Better Auth API Key

The composition style intentionally follows Better Auth's
`packages/api-key` package from Better Auth `1.6.24`, the version pinned by this
workspace. The reference is architectural, not a copy of its authentication or
persistence semantics.

| Reference pattern                                                                               | Hot Updater decision                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A factory returns one declarative plugin object with a stable `id` and `version`.               | `analytics()` and `betterAuthPlugin()` return opaque first-party manifests.                                                                  |
| One plugin owns its endpoints, validation, error vocabulary, options, and inferred API surface. | `analytics()` owns all Analytics routes, payload parsing, feature errors, metadata, and typed runtime API.                                   |
| Options are normalized once and duplicate configuration identities fail early.                  | Plugin options are normalized during construction; duplicate plugin, route, API, capability, middleware, and metadata ownership is rejected. |
| Endpoint declarations carry method, path, input schema, and documentation metadata together.    | A Hot Updater route manifest carries method, path, access, request policy, runtime parser, and handler together.                             |
| Server endpoint declarations drive typed client/server API inference.                           | The plugin tuple passed to `createHotUpdater` drives the namespaced `features` API type.                                                     |
| A separate client companion can infer the server plugin.                                        | A future Analytics client package may infer the Analytics manifest; it is not required for the kernel release.                               |

The following Better Auth details are deliberately not copied:

- schema merging or plugin-owned migration generation;
- array-order hook semantics;
- last-wins endpoint or API merging;
- logging route conflicts while continuing construction;
- arbitrary request/response hooks before authentication;
- API-key headers, hashing, sessions, permissions, rate limits, or key storage
  as **kernel** concepts. Those details remain owned by Better Auth and
  `@better-auth/api-key`.

Hot Updater providers retain their existing migrations, plugin order is
semantically irrelevant, and every ownership conflict is a construction error.

## Requirements

### Functional requirements

1. `createHotUpdater` accepts a set of server plugins.
2. Omitting `analytics()` removes every Analytics route, handler, runtime
   metadata contribution, and Analytics-only public type.
3. Installing `analytics()` contributes the complete Analytics HTTP feature.
4. `analytics()` consumes the kernel's frozen, schema-guarded generic database
   runtime and creates its bounded provider without modifying the database
   plugin.
5. Dedicated implementations are supplied to `analytics()` through its
   provider-factory option; `standaloneAnalytics()` is the supported standalone
   companion.
6. Installing `analytics()` always yields an available feature at construction
   time. Runtime availability metadata may still report independent remote
   ingestion and query support.
7. Remote standalone availability may remain asynchronous, but
   unavailable or indeterminate remote operations fail closed.
8. The same plugin set produces the same route manifest and access behavior
   regardless of plugin array order.
9. Route, plugin, capability-provider, metadata-wire-key, API-namespace, API
   alias, middleware-ID, and authentication-provider conflicts fail
   construction.
10. Every route declares access explicitly.
11. Protected routes execute authentication after route matching and before
    body consumption, handler invocation, database access, or storage access.
12. `HandlerOptions` remains non-generic.
13. `routes.eventIngestion` is not introduced.
14. The `plugins` tuple determines the returned feature API type. Omitting
    `analytics()` removes the Analytics namespace at compile time and runtime;
    installing it yields the available Analytics API.
15. Feature plugins cannot contribute database migrations or asynchronous
    lifecycle work. Infrastructure setup and cleanup remain database and
    storage responsibilities.
16. `HandlerOptions.routes` is the only public selector for the built-in
    handler routes and has the named, non-generic `HandlerRoutes` type.
17. A `protect-all` contribution applies to the final union of core and feature
    routes, independent of plugin order. No plugin policy can make a protected
    route public.
18. `betterAuthPlugin({ auth })` and the managed Better Auth preset both
    protect every route produced by the composed handler.
19. Managed AWS, Cloudflare, Firebase, and Supabase handlers require the
    provisioned API key for every mounted HTTP API.

### Compatibility requirements

The extraction preserves the existing Analytics HTTP surface exactly:

| Method | Base-path-relative path                | Owner               |
| ------ | -------------------------------------- | ------------------- |
| `POST` | `/events`                              | Analytics ingestion |
| `GET`  | `/api/bundles/:id/events/summary`      | Analytics query     |
| `GET`  | `/api/bundles/:id/events/analytics`    | Analytics query     |
| `GET`  | `/api/installations`                   | Analytics query     |
| `GET`  | `/api/installations/overview`          | Analytics query     |
| `GET`  | `/api/installations/active`            | Analytics query     |
| `GET`  | `/api/installations/:installId/events` | Analytics query     |

Request and response shapes, headers, pagination defaults and bounds, scan
bounds, analytics windows, string limits, the 16 KiB ingestion limit, error
statuses, and SDK-version forwarding are preserved by golden fixtures.
`/version.capabilities` also preserves the existing flat standalone protocol:

```json
{
  "analytics": true,
  "mode": "bounded",
  "eventIngestion": true,
  "analyticsQueries": true
}
```

Changing or removing this shape requires a separately versioned standalone
protocol migration. It is not silently removed with the old source API.
This byte-preservation rule applies when `analytics()` or the legacy bridge is
installed. Intentionally omitting the plugin contributes no Analytics keys;
warn-mode provider absence contributes only the three false availability keys,
and AWS/blob presets omit them.

The extraction also preserves:

- update-check behavior;
- base-path application exactly once;
- managed Cloudflare, Firebase, and Supabase entrypoints;
- standalone route overrides and independent upstream credentials;
- current provider migration assets and schema versions.

Wire compatibility does not imply literal source compatibility. The new
plugin-based entrypoint replaces `routes.analytics` with `analytics()`.
Migration helpers are provided by the Analytics package, and the removal is
released and documented as a breaking source change.

Managed authentication is an intentional wire-policy change: unauthenticated
requests that previously reached a managed handler now receive `401`, including
update checks, `/version`, and Analytics ingestion. Clients must send the
provisioned key in `x-api-key`.

### Security requirements

- No protected handler runs without a successful authentication result.
- Authentication failure cannot become success through plugin order.
- Missing or invalid credentials return an opaque `401`.
- An unavailable authentication dependency returns an opaque `503`; unexpected
  authentication failures return an opaque `500`.
- All authentication failures short-circuit subsequent middleware and handler
  execution.
- Exactly one authentication provider is supported in the first version.
- A deployment needing multiple credential mechanisms must supply one
  explicitly composed authentication provider.
- Principal state is validated, frozen, request-local, and is not merged into
  `HotUpdaterContext<TContext>`.
- Raw credentials, provider sessions, cookies, API keys, and provider errors
  never enter runtime metadata or logs.
- Protect-all is monotonic: it may upgrade public route declarations to
  protected, but no policy can downgrade a protected route.
- Managed Better Auth verification accepts only a configured SHA-256 digest at
  runtime and does not retain the raw key.
- Managed provisioning never uploads, emits in generated source, or logs the
  raw key. Only the local provisioning result and local environment file
  receive it.
- AWS managed handler responses are not shared-cacheable. Its CloudFront
  handler behavior disables caching in addition to returning `no-store`.
- Plugins are trusted in-process code. The capability registry is not a
  sandbox.

## Non-goals

- A general-purpose application framework.
- Runtime plugin loading, unloading, or hot reload.
- Asynchronous route registration after `createHotUpdater` returns.
- Generic plugin-owned database migration composition.
- Deep merging arbitrary plugin metadata.
- Making API keys a kernel primitive; API-key behavior belongs to Better Auth,
  `@better-auth/api-key`, and `@hot-updater/better-auth`.
- Mounting Better Auth's own handler or management routes.
- Running Better Auth migrations from Hot Updater.
- Reintroducing `authorize: () => true`.
- Route-level authorization or permission policy. The first version gates a
  protected route on authentication only.
- Reintroducing `routes.eventIngestion`.
- Making `HandlerOptions` generic.
- Supporting an open, versioned third-party feature-plugin ABI in the first
  release.
- Feature-plugin lifecycle hooks or plugin-level dependency ordering.
- Arbitrary unscoped API-object merging.
- Treating a key shipped in a mobile binary as an administrator secret, user
  identity, DRM mechanism, or durable defense against a determined client.
- Managed multi-key overlap, remote rotation, revocation, per-device keys, and
  permission policy in this release.

Custom database and storage implementations remain supported. First-party
feature manifests establish the initial kernel contract. Third-party feature
authoring becomes supported only after a conformance suite and versioned ABI
are published.

## Legacy contradictions addressed

The pre-kernel implementation crossed the target boundary in several places:

- `CreateHotUpdaterOptions.routes` included `routes.analytics`;
- `createHandler` imported Analytics capability resolution and Analytics route
  factories;
- `HandlerAPI` and `DatabaseAPI` included Analytics APIs;
- `createDatabasePluginCore` discovered and materialized Analytics services;
- `createDatabasePlugin` automatically marked Analytics support;
- the core `/version` handler constructed Analytics metadata;
- `@hot-updater/server/node` imported the event body limit and recognized
  `/events`;
- standalone publicly enumerated Analytics operations and probed Analytics
  fields;
- managed runtimes enabled Analytics through `routes.analytics: true`.

Moving route files alone would not have been sufficient. The implementation
removes each feature-specific dependency above or replaces it with the generic
kernel primitive specified in this document.

## Package ownership

### `@hot-updater/server`

Owns:

- `createHotUpdater`;
- the setup-time plugin composer;
- the router and normalized base path;
- route collision detection;
- fixed request phases;
- generic authentication and principal types;
- generic capability collection;
- generic version-metadata projection;
- core update-check and bundle-management behavior;
- framework-neutral `Request` to `Response` dispatch.

Must not import `@hot-updater/analytics`.

The kernel is an internal module of this package in the first release, not a
new published `@hot-updater/server-kernel` package. Update check is enabled by
default. Bundle management remains a separately mountable core surface.
`/version` has public access before policies are applied, and its metadata
payload remains credential-invariant. A protect-all policy upgrades it to
protected access together with every other route. Feature manifests cannot
override core routes or downgrade their access.

Separately packed first-party features use the explicitly unsupported,
non-root `@hot-updater/server/internal/first-party-plugin` authoring subpath.
It exports the factory and contract witnesses required to construct a nominal
manifest, while keeping the unique brand private. The supported server root
exposes only opaque manifests and no third-party authoring API.

### `@hot-updater/plugin-core`

Owns generic database, storage, and capability-carrier primitives. It carries
opaque values but does not define Analytics domain tokens or high-level event
and installation result types.

It also owns `CapabilityToken<T>`, `defineCapability`, immutable contribution
attachment, frozen carrier contracts, generic infrastructure-runtime types,
and a narrow unsupported enumeration seam used by server. Server remains
responsible for guarded runtime construction, factory invocation, parser
validation, duplicate detection, and the read-only registry.

During the first migration stage, the raw `bundle_events` persistence row and
model may remain an internal provider/storage contract so existing SQL, Mongo,
Firebase, and D1 adapters continue to compile against their released schemas.
That temporary persistence shape is not a public Analytics service API.
High-level Analytics service/domain/token exports leave plugin-core during
Stage 1; shared boundaries use neutral model-indexed persistence names.

### `@hot-updater/analytics`

Owns:

- `analytics()`;
- the Analytics provider factory contract and runtime validator;
- the default bounded provider over the guarded generic database runtime;
- event and installation domain types;
- ingestion and query route manifests;
- payload parsing and body-size limits;
- handlers and feature-specific errors;
- bounded and dedicated query behavior;
- remote standalone availability semantics;
- Analytics metadata for the current `/version.capabilities` protocol;
- the namespaced Analytics runtime API and temporary flat API aliases.

Provider authoring APIs are exported from
`@hot-updater/analytics/provider`.

### `@hot-updater/better-auth`

Owns:

- `betterAuthPlugin({ auth })` session adaptation;
- conversion from a configured Better Auth instance to the generic
  authentication result;
- a monotonic protect-all policy for every route emitted by
  `createHotUpdater`;
- Better Auth-specific error normalization.
- `@hot-updater/better-auth/managed`, including
  `managedBetterAuthPlugin({ apiKeySha256 })`;
- `@hot-updater/better-auth/managed/provisioning`, including
  `provisionManagedBetterAuthApiKey({ envFilePath? })`.

The root package does not construct Better Auth, install
`@better-auth/api-key`, mount `auth.handler`, or own Better Auth schema
migrations. The application configures and migrates Better Auth, and enables
`enableSessionForAPIKeys` when API keys must become sessions.

The managed subpath is a narrow preset for one deployment key. It receives only
a canonical base64url SHA-256 digest and projects it through the same
Better Auth session authentication contract without a provider database.
Provisioning returns `{ apiKey, sha256 }` and writes the raw value as
`HOT_UPDATER_API_KEY` only to the local environment file. It uses
`.env.hotupdater` in the current directory by default; `envFilePath` selects an
alternate local path. It does not provide a remote key registry, permissions,
expiration, overlapping rotation, revocation, or database schema.

### Provider packages

Cloudflare, Firebase, Supabase, AWS, and custom providers retain ownership of:

- provider schema and migrations;
- database and storage credentials;
- provider contexts;
- infrastructure provisioning;
- optional Analytics provider implementations;
- managed digest injection and cache policy.

Moving Analytics code does not move or replay provider database migrations.

`@hot-updater/server/adapters/{drizzle,kysely,mongodb,prisma}` remain generic
and never attach Analytics metadata or provider wiring. A self-hosted consumer
opts in only at the feature boundary:

```typescript
createHotUpdater({
  database: prismaAdapter(options),
  plugins: [analytics()],
});
```

Cloudflare, Firebase, Supabase, and PostgreSQL database plugins remain
Analytics-agnostic. The Cloudflare, Firebase, and Supabase managed server
entrypoints install `analytics()` explicitly. AWS and blob-backed providers
remain valid core-only providers because their server presets omit it.

## Public composition

```typescript
import { apiKey as betterAuthApiKey } from "@better-auth/api-key";
import { analytics } from "@hot-updater/analytics";
import { betterAuthPlugin } from "@hot-updater/better-auth";
import { createHotUpdater } from "@hot-updater/server";
import { prismaAdapter } from "@hot-updater/server/adapters/prisma";
import { betterAuth } from "better-auth";

const auth = betterAuth({
  database: authDatabase,
  plugins: [
    betterAuthApiKey({
      enableSessionForAPIKeys: true,
    }),
  ],
});

const hotUpdater = createHotUpdater({
  database: prismaAdapter(databaseOptions),
  storages,
  plugins: [analytics(), betterAuthPlugin({ auth })],
  basePath: "/api/check-update",
});

const analyticsFeature = hotUpdater.features.analytics;

await analyticsFeature.getBundleEventSummary(input);
```

The application creates and stores the API-key record through Better Auth.
Better Auth reads `x-api-key` by default and, because
`enableSessionForAPIKeys` is enabled, exposes a valid key through
`auth.api.getSession`. `betterAuthPlugin({ auth })` contributes protect-all, so
`/version`, update checks, bundle management, Analytics ingestion, and
Analytics queries all require a valid Better Auth session whenever they are
present. The Hot Updater plugin has no header, `configId`, permission, or
direct API-key verification option.

The same database without `analytics()` exposes no Analytics behavior or
Analytics runtime API:

```typescript
const hotUpdater = createHotUpdater({
  database: analyticsCapableDatabase,
  plugins: [],
});
```

Managed runtimes use the digest-backed Better Auth preset:

```typescript
import { analytics } from "@hot-updater/analytics";
import { managedBetterAuthPlugin } from "@hot-updater/better-auth/managed";

createHotUpdater({
  database: managedAnalyticsDatabase,
  plugins: [
    analytics(),
    managedBetterAuthPlugin({
      apiKeySha256: HotUpdater.API_KEY_SHA256,
    }),
  ],
});
```

No no-op authenticator or `authorize: () => true` is installed. The managed
plugin authenticates through the Better Auth session contract and contributes
the monotonic policy; the managed database plugin remains unaware of API keys
and Analytics.

### Public option and return types

`HandlerOptions` is deliberately non-generic. Platform context typing belongs
to `CreateHotUpdaterOptions`, not the HTTP route composer.

```typescript
export type HandlerRoutes = {
  readonly updateCheck?: boolean;
  readonly bundles?:
    | false
    | true
    | {
        readonly access: HotUpdaterRouteAccess;
      };
};

export interface HandlerOptions {
  readonly basePath?: string;
  readonly routes?: HandlerRoutes;
}

export interface CreateHotUpdaterOptions<TContext> extends HandlerOptions {
  readonly database: DatabasePlugin;
  readonly storages?: readonly RuntimeStoragePlugin<TContext>[];
  readonly plugins?: readonly FirstPartyFeatureManifest[];
}
```

`routes` is the sole public name; `coreRoutes` may be used by private composer
implementation details but is not exported or accepted in public options.
Before plugin policies, `GET /version` and update checks are public, and update
check is enabled by default. Bundle management is disabled by default; when
enabled it is protected unless the deployment explicitly declares public
access. A protect-all policy then upgrades every mounted route, including
explicitly public routes, to protected. There is no inverse policy.

The call signature preserves the literal plugin tuple:

```typescript
declare function createHotUpdater<
  TContext = undefined,
  const TPlugins extends readonly FirstPartyFeatureManifest[] = readonly [],
>(
  options: Omit<CreateHotUpdaterOptions<TContext>, "plugins"> & {
    readonly plugins?: TPlugins;
  },
): RuntimeHotUpdaterAPI<TContext> &
  Readonly<ProjectPlugins<TPlugins, TContext>>;
```

`ProjectPlugins` is an internal type-level fold from each branded
manifest's fixed namespace and private `FeatureApiKind` witness to its API type
after applying `TContext`. Omitted plugins infer an exact frozen empty feature
object, never the widened first-party manifest array. Installed features carry
their transitional aliases. `analytics()` has fixed plugin ID and namespace
`"analytics"` and the package version as its manifest version; none can be
overridden through options. `analytics()` accepts one normalized configuration
object, not a configuration array or fallback ID. Two instances fail with
`DUPLICATE_PLUGIN_ID` before setup.

The Analytics factory accepts feature-owned provider selection:

```typescript
export interface AnalyticsOptions {
  readonly provider?: AnalyticsProviderFactory;
  readonly queryAccess?: "protected" | "public";
}

export type AnalyticsProviderFactory = (
  database: DatabaseCapabilityRuntime,
) => AnalyticsProvider;

export type AnalyticsFeatureAvailable = Readonly<
  AnalyticsAPI & {
    status: "available";
  }
>;
```

`analytics()` defaults to protected query access and a bounded provider over
the guarded generic database runtime. A dedicated provider factory overrides
only provider creation; the Analytics feature still owns routes, validation,
metadata, and its API.

## Kernel contracts

The following types describe the contract shape. Exact names may change during
implementation, but their invariants are normative.

### Capability token

Capability values cross a runtime package boundary and therefore require a
runtime parser. TypeScript generics alone are insufficient.

```typescript
declare const capabilityTokenBrand: unique symbol;

export interface CapabilityToken<TValue> {
  readonly [capabilityTokenBrand]: TValue;
  readonly id: `${string}@${number}`;
  readonly parse: (value: unknown) => TValue;
}

export interface CapabilityRegistry {
  readonly get: <TValue>(token: CapabilityToken<TValue>) => TValue | undefined;
  readonly require: <TValue>(token: CapabilityToken<TValue>) => TValue;
}

export interface CapabilityRequirement<TValue> {
  readonly token: CapabilityToken<TValue>;
  readonly missing: "continue" | "error";
}

export interface CapabilityContribution<TValue> {
  readonly token: CapabilityToken<TValue>;
  readonly create: (runtime: HotUpdaterInfrastructureRuntime) => unknown;
}
```

The internal `defineCapability` factory creates nominal, versioned tokens.
Consumers cannot reproduce a token structurally. Duplicate token IDs or
providers and advertised values that fail their parser fail construction.
Missing values follow the requesting manifest's declared policy.

Only database, storage, and provider infrastructure carriers contribute
capability factories. After the kernel creates its guarded database and storage
runtime, it invokes each synchronous factory and validates the returned value
with the token parser. Feature plugins declare requirements but cannot provide
their own required capability. The registry is passed as a read-only view to
feature setup and is not exposed as a mutable service locator.

Every database-backed capability receives a frozen, narrow
`DatabaseCapabilityRuntime` that is compatible only with generic CRUD and
transaction operations. Each method enters the same memoized schema-readiness
gate as core operations. The facade exposes no raw database, callback escape,
migrator, schema generator, adapter/provider fields, configuration, or
credentials. The wrapper itself does not claim that schema is ready and does
not run migrations, network calls, or queries.

The Analytics token and parser live in `@hot-updater/analytics/provider`.
Provider packages may know that contract. `@hot-updater/server` and
`@hot-updater/plugin-core` do not.

### Plugin manifest

Plugin setup is synchronous and declaration-only. The low-level manifest is a
non-exported, branded first-party contract. Consumers use public factories such
as `analytics()` and `betterAuthPlugin()`; v1 does not publish a supported
third-party `defineServerPlugin` API.

```typescript
declare const featureManifestBrand: unique symbol;

interface HotUpdaterFeatureManifest<
  TNamespace extends string,
  TFeature extends object,
  TAvailableApi extends object,
> {
  readonly [featureManifestBrand]: {
    readonly namespace: TNamespace;
    readonly feature: TFeature;
    readonly availableApi: TAvailableApi;
  };
  readonly id: string;
  readonly version: string;
  readonly requires?: readonly CapabilityRequirement<unknown>[];
  readonly setup: (
    context: HotUpdaterPluginSetupContext,
  ) => HotUpdaterPluginContribution<TNamespace, TFeature, TAvailableApi>;
}

export interface HotUpdaterPluginSetupContext {
  readonly capabilities: CapabilityRegistry;
  readonly database: DatabaseCapabilityRuntime;
  readonly diagnostics: HotUpdaterConstructionDiagnostics;
}

export interface HotUpdaterConstructionDiagnostics {
  readonly warn: (diagnostic: {
    readonly code: string;
    readonly message: string;
  }) => void;
}

interface HotUpdaterPluginContribution<
  TNamespace extends string,
  TFeature extends object,
  TAvailableApi extends object,
> {
  readonly routes?: readonly HotUpdaterServerRoute[];
  readonly routePolicy?: HotUpdaterRoutePolicy;
  readonly middleware?: readonly HotUpdaterPostAuthMiddleware[];
  readonly authentication?: HotUpdaterAuthenticationProvider;
  readonly metadata?: readonly HotUpdaterVersionMetadataContribution[];
  readonly api?: HotUpdaterFeatureApiContribution<
    TNamespace,
    TFeature,
    TAvailableApi
  >;
}

interface HotUpdaterFeatureApiContribution<
  TNamespace extends string,
  TFeature extends object,
  TAvailableApi extends object,
> {
  readonly namespace: TNamespace;
  readonly value: TFeature;
  readonly legacyAliases?: Readonly<
    Record<string, keyof TAvailableApi & string>
  >;
}
```

Capabilities are collected and validated before any plugin's `setup` function
runs. Setup cannot perform migrations, open infrastructure, register work
later, or mutate another plugin's contribution. Feature manifests have no
lifecycle hooks or plugin-level dependency graph in v1. Existing database and
storage setup and cleanup contracts remain responsible for infrastructure
lifetime.

A `"continue"` requirement lets setup return an unavailable feature
contribution. Its diagnostics sink emits a structured warning at most once per
plugin ID and construction. Warnings contain a stable code and static message
only; they cannot contain provider errors, credentials, sessions, or
configuration values. An `"error"` requirement fails before setup with
`MISSING_CAPABILITY`.

`createHotUpdater` infers the intersection of namespaced feature states from
the literal plugin tuple and exposes them under `hotUpdater.features`. The
manifest separately carries the API type of its available branch so
transitional aliases do not collapse to the common keys of an availability
union. Contributions and the final API object are frozen. Duplicate namespaces
and aliases, aliases that shadow core APIs, and aliases that do not name an
available API member fail construction. Flat aliases exist only for the source
migration window and are installed only when the runtime feature state is
available.

### Routes

```typescript
export type HotUpdaterRoutePolicy = {
  readonly kind: "protect-all";
};

export type HotUpdaterRouteAccess =
  | { readonly kind: "public" }
  | { readonly kind: "protected" };

export interface HotUpdaterRequestParser<TInput> {
  readonly parse: (request: Request) => Promise<TInput>;
}

export interface HotUpdaterServerRoute<TInput = undefined> {
  readonly id: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: `/${string}`;
  readonly access: HotUpdaterRouteAccess;
  readonly requestPolicy?: HotUpdaterRequestPolicy;
  readonly input?: HotUpdaterRequestParser<TInput>;
  readonly handle: (
    context: HotUpdaterRouteContext,
    input: TInput,
  ) => Promise<Response>;
}

export interface HotUpdaterRequestPolicy {
  readonly maximumBodyBytes?: number;
}
```

Route paths are relative to `basePath`. The kernel normalizes and applies the
base path once.

Route identity is the combination of normalized method, normalized path, and
stable route ID. Duplicate IDs, duplicate method/path pairs, canonically
equivalent parameter routes such as `/x/:id` and `/x/:name`, and core-route
overrides fail construction. A static segment always outranks a parameter
segment, so `/api/bundles/channels` and `/api/bundles/:id` coexist regardless of
registration order.

Request policies are generic route metadata. Framework adapters must preserve
raw request streams for every method that may carry a body. A declared
`Content-Length` may be rejected from request headers before authentication.
The actual stream byte count and parsing occur only after successful
authentication on protected routes. No adapter may recognize `/events` or
import an Analytics constant.

The route owner declares path, method, access, request policy, runtime input
parser, and handler together. This follows the Better Auth endpoint pattern
without importing its router or schema-merging behavior.

Route policies are intentionally smaller than route declarations. The only
policy in this release is `protect-all`. The composer applies it to the final
route set after every plugin has contributed routes, so the result is
independent of plugin order and includes routes owned by the same manifest.
Applying it twice is idempotent. It can only replace `{ kind: "public" }` with
`{ kind: "protected" }`; it cannot remove routes, select paths, change handlers,
or downgrade access.

### Authentication and middleware

```typescript
export interface HotUpdaterPrincipal {
  readonly subject: string;
  readonly issuer: string;
}

export type HotUpdaterAuthenticationResult =
  | {
      readonly kind: "authenticated";
      readonly principal: HotUpdaterPrincipal;
    }
  | { readonly kind: "anonymous" }
  | { readonly kind: "unavailable" };

export interface HotUpdaterAuthenticationProvider {
  readonly id: string;
  readonly authenticate: (
    input: HotUpdaterAuthenticationInput,
  ) => Promise<HotUpdaterAuthenticationResult>;
}

export interface HotUpdaterAuthenticationInput {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly url: URL;
  readonly headers: Headers;
  readonly signal: AbortSignal;
  readonly route: HotUpdaterMatchedRoute;
}

export interface HotUpdaterPostAuthMiddleware {
  readonly id: string;
  readonly phase: "post-auth";
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly handle: (
    context: HotUpdaterRequestExecutionContext,
    next: () => Promise<Response>,
  ) => Promise<Response>;
}
```

The authentication provider is mechanism-neutral. It does not name sessions,
JWTs, API keys, headers, or Better Auth. It receives a body-less, defensive
request-head view. It cannot return a `Response`.

Every route declares access. A protected route without exactly one
authentication provider fails construction. Public routes do not require an
authentication provider and do not invoke one. Route owners declare initial
access, authentication manifests may contribute only the monotonic policy, and
the kernel computes and freezes effective access. Authentication code never
makes a per-request access decision.

On a protected route, `anonymous` maps to an opaque `401`, `unavailable` maps to
an opaque `503`, an invalid result or unexpected exception maps to an opaque
`500`, and `authenticated` is accepted only after principal validation. The
kernel creates these responses; provider messages, headers, cookies, and error
objects are never exposed.

For an authenticated result, the kernel reads and copies only `subject` and
`issuer` into a new plain frozen request-local object. Both must be primitive,
well-formed Unicode strings that are already trimmed, non-empty, and contain no
U+0000-U+001F or U+007F control character. Their serialized UTF-8 limits are
1,024 bytes for `subject` and 2,048 bytes for `issuer`. The kernel performs no
Unicode normalization, case folding, or issuer-URL validation. Extra session
fields, accessor failures, or an invalid principal map to the same opaque
`500`.

The first version uses fixed security phases:

```text
central error boundary
  -> route match
  -> request-head guards without body reads
  -> unique authentication provider
  -> bounded-body reader installation
  -> post-auth middleware
  -> route handler and body consumption
  -> reverse response unwind
```

Plugin array order cannot move authentication behind body parsing or a handler.
Feature plugins cannot contribute pre-auth middleware. Request-head guards come
only from declarative route policy and cannot produce a successful response for
a protected route.

Post-auth middleware uses a `before`/`after` DAG within its single phase.
Unknown IDs and cycles fail construction; unrelated middleware uses lexical ID
order. `next()` may be called at most once. Returning without `next()`
short-circuits, successful unwind is reverse execution order, and middleware
exceptions pass through the central opaque error boundary.

Principal state lives in an internal request execution object. It is never
stored globally and is not added to `HandlerOptions` or platform context.

### Metadata

Internal ownership and wire projection are separate. Metadata is not
deep-merged.

```typescript
export interface HotUpdaterVersionMetadataContribution {
  readonly namespace: string;
  readonly target: "capabilities";
  readonly keys: readonly string[];
  readonly resolve: (
    signal: AbortSignal,
  ) => Promise<Readonly<Record<string, JsonValue>>>;
}
```

Duplicate namespaces, duplicate declared wire keys, and reserved core fields
fail construction. The core invokes all resolvers concurrently without an
inbound request under one aggregate five-second deadline and passes one
kernel-owned `AbortSignal` that every first-party resolver must honor. It
validates exact declared keys and recursive `JsonValue`, then enforces 16 KiB
of serialized UTF-8 per contribution and 64 KiB aggregate. Only after every
contribution passes does it atomically shallow-merge the result into
`/version.capabilities`. Timeout, throw, invalid keys or JSON, or oversize
produces one opaque `500` with no partial metadata or dynamic detail. The core
does not allowlist Analytics names.

Metadata is byte-for-byte invariant to inbound credentials. Secrets,
authentication mechanisms, policies, principals, provider configuration, and
provider errors are forbidden. The Analytics plugin owns the existing flat
Analytics capability keys, including its asynchronous standalone resolution.

## Composition algorithm

`createHotUpdater` performs the following synchronous phases:

1. Normalize database, storage, base path, and plugin identities.
2. Create the existing guarded database and storage infrastructure runtime.
3. Collect capability factories from infrastructure carriers only.
4. Invoke the factories synchronously with the guarded runtime and validate
   each returned value with its token parser.
5. Reject duplicate capability token IDs, then duplicate providers.
6. Validate plugin identities and capability requirements.
7. Run synchronous plugin setup in stable plugin-ID order.
8. Collect and normalize routes; reject route and route-ID conflicts.
9. Validate route policies and apply protect-all monotonically to the complete
   route set.
10. Collect feature APIs and transitional aliases; reject ownership conflicts.
11. Collect metadata projections; reject namespace and wire-key conflicts.
12. Select exactly zero or one authentication provider.
13. Reject protected routes when no authentication provider is installed.
14. Compile the post-auth middleware DAG.
15. Freeze every route, middleware, capability, metadata, and API manifest.
16. Return the runtime handler, core API, and plugin-inferred `features` API.

Setup failures, missing required capabilities, invalid advertised
capabilities, invalid contributions, middleware dependency cycles, unknown
middleware edges, and ownership collisions are typed construction errors. No
first-wins, last-wins, or array-order behavior is permitted.

## Analytics composition

`analytics()`:

1. validates, normalizes, and freezes its options in the factory;
2. returns the concrete literal manifest with fixed ID, namespace, and package
   version without widening away its API type;
3. receives the kernel's frozen, schema-guarded generic database runtime;
4. creates the bounded provider from that runtime unless an explicit provider
   factory is configured;
5. validates the resulting provider before contributing anything;
6. contributes ingestion and query routes;
7. declares ingestion public by default;
8. declares Analytics and installation queries protected by default;
9. owns all parsing, limits, errors, and handlers;
10. contributes truthful Analytics capability metadata;
11. preserves independent remote ingestion/query availability for standalone.

Following the Better Auth API Key package's named endpoint-record pattern, one
Analytics operation registry is the source for both HTTP route declarations
and `features.analytics` methods. Operation names, parsers, handlers, and
return types cannot be maintained in separate parallel maps. The feature
manifest has no generic `options`, `schema`, `migrations`, `init`, or cleanup
field.

The public configuration does not gain `routes.eventIngestion`. A protect-all
policy can upgrade Analytics ingestion without adding an Analytics-specific
route option.

For an intentionally public, self-hosted Analytics deployment, the Analytics
plugin receives `analytics({ queryAccess: "public" })` and does not install a
protect-all authentication plugin. Managed providers use the Analytics
default, then the managed Better Auth policy upgrades ingestion and every
other mounted route. Protected routes are never silently downgraded because
an authentication provider is absent.

The kernel passes the same guarded database runtime used by core operations to
the feature factory. Every default Analytics database call therefore crosses
the existing schema-readiness guard. Database plugins are not wrapped, mutated,
or asked to advertise Analytics.

For standalone, `standaloneAnalytics(config)` creates an Analytics manifest
whose explicit provider factory owns the remote transport. Construction makes
no network call. Remote ingestion and query availability are resolved
independently at request and metadata time with the existing 30-second fresh
cache, 5-minute bounded stale fallback, and 5-second timeout. An unavailable or
indeterminate operation fails closed without disabling an independently
available operation.

## Better Auth composition

`betterAuthPlugin` receives a configured Better Auth instance. Its session
operation is:

1. receive the already matched route and defensive copy of the request head;
2. call `auth.api.getSession({ headers })`;
3. normalize a valid session to a validated `HotUpdaterPrincipal`;
4. return only `anonymous`, `authenticated`, or `unavailable`;
5. contribute `routePolicy: { kind: "protect-all" }`.

```typescript
const auth = betterAuth({
  database,
  plugins: [
    apiKey({
      enableSessionForAPIKeys: true,
    }),
  ],
});

betterAuthPlugin({ auth });
```

The actual adapter receives the body-less authentication input, not a
body-capable `Request`, and cannot return an HTTP response. It neither installs
nor infers Better Auth's API-key plugin. An application that wants API keys
must install `@better-auth/api-key` and enable its session integration.
Header names, key configuration, permissions, rate limits, key creation, and
revocation remain Better Auth concerns. There is no Hot Updater `apiKey`,
`configId`, header, permission, path predicate, downgrade-capable `protect`, or
`authorize` option.

The kernel's status guarantee is exact for provider-classified results. In
session mode, Better Auth's public session API may collapse an internal
dependency failure to the same `null` used for an absent session, which an
adapter cannot disambiguate. Locked-version fault injection also proves that
Better Auth 1.6.24 catches a session-store error carrying `status: 503` and
surfaces an `APIError` with `status: "INTERNAL_SERVER_ERROR"` and
`statusCode: 500`. The adapter therefore maps `null` to `anonymous`, only
still-classified observable outage errors to `unavailable`, and
classification-erased or otherwise unexpected throws to the kernel's opaque
`500`. A swallowed outage remains fail-closed as `401`; a
classification-erased outage remains fail-closed as `500`.

These are documented provider-library limitations and deferred upstream
issues, not claimed exact-`503` cases. A generic non-Better-Auth provider must
exercise the exact `unavailable` to `503` conformance branch. No
health-preflight workaround is introduced. Better Auth 1.6.24's default logger
receives the original store error before its public API rewrites that error.
The adapter neither receives nor re-logs that original value, and it cannot
safely mutate the caller's configured Better Auth instance. Deployments with
strict log-secrecy requirements must therefore disable or sanitize the Better
Auth dependency logger when constructing that instance.

Better Auth key creation, secret delivery, rotation, revocation, permissions,
and migrations remain application responsibilities.

## Managed Better Auth composition

`managedBetterAuthPlugin({ apiKeySha256 })` is the database-independent managed
authentication manifest. It validates and freezes the configured digest at
construction and contributes exactly one Better Auth authentication provider
plus protect-all. It contributes no HTTP route, metadata, feature API,
migration, or lifecycle hook.

For each protected request, the provider hashes the presented header value,
compares it with the projected key record, and resolves the result through the
same Better Auth session contract used by `betterAuthPlugin({ auth })`. Missing
and mismatched keys are anonymous. Neither the raw key nor its digest becomes
principal state, metadata, response detail, or a log field. Malformed
configured digests fail construction rather than making every request
anonymous.

The managed projection is ephemeral and in-memory, and deliberately verifies one deployment
key. It is not a general Better Auth database and does not support remote
revocation, per-user keys, or overlapping rotation. Key generation and local
delivery belong to `@hot-updater/better-auth/managed/provisioning`, while
provider IaC transports only the digest. The split keeps filesystem access and
secret generation out of request runtimes and keeps provider-specific
deployment logic out of the authentication package.

## Standalone boundaries

Standalone has two independent credential boundaries:

- inbound client to the local Hot Updater handler;
- outbound standalone provider to its upstream server.

Inbound cookies, authorization headers, principals, and API keys are never
forwarded upstream automatically.

Stage 1 preserves the existing outbound-only `commonHeaders` and per-route
header configuration. It nevertheless adds mandatory transport guards before
any configured credential is sent:

- canonicalize `baseUrl` and every destination;
- reject URL user information and absolute, scheme-relative, backslash,
  fragment, or base-path-escaping custom routes;
- preserve the configured base pathname when resolving a relative route;
- require the destination origin to equal the canonical `baseUrl` origin;
- reject credential-bearing redirects with `redirect: "error"` in Stage 1;
- never use inbound headers or principal state as outbound configuration.

A per-request outbound credential provider is a later additive API. It becomes
mandatory before any standalone deployment relies on rotating outbound
credentials.
At that point it owns sensitive authentication headers and route overrides
cannot replace them.

The standalone Analytics provider retains its bounded cache, stale fallback,
timeout, and independent ingestion/query availability. The dedicated provider
is installed by `standaloneAnalytics(config)` at the feature boundary.
Analytics owns route parsing, metadata, and availability interpretation. The
standalone package owns one generic guarded transport, route configuration,
and outbound credential enforcement; `standaloneRepository(config)` remains
free of Analytics wiring.

## Managed provider policy

Every managed server preset installs
`managedBetterAuthPlugin({ apiKeySha256: HotUpdater.API_KEY_SHA256 })`. The
plugin contributes one Better Auth authentication provider and protect-all;
the policy applies after Analytics routes are installed. The exact default
matrix is:

| Managed handler | `/version` | Update-check routes | Bundle routes | Analytics ingestion | Analytics queries |
| --------------- | ---------- | ------------------- | ------------- | ------------------- | ----------------- |
| AWS             | protected  | protected           | not mounted   | not mounted         | not mounted       |
| Cloudflare      | protected  | protected           | not mounted   | protected           | protected         |
| Firebase        | protected  | protected           | not mounted   | protected           | protected         |
| Supabase        | protected  | protected           | not mounted   | protected           | protected         |

Cloudflare, Firebase, and Supabase explicitly install `analytics()`. AWS does
not install Analytics. A route that is not mounted is not implied by the
protect-all policy; every route that the resulting handler does expose requires
the key.

Managed provisioning uses
`@hot-updater/better-auth/managed/provisioning`:

```typescript
import { provisionManagedBetterAuthApiKey } from "@hot-updater/better-auth/managed/provisioning";

const { apiKey, sha256 } = await provisionManagedBetterAuthApiKey({
  envFilePath: ".env.hotupdater",
});
```

Provisioning generates the key locally, returns `{ apiKey, sha256 }`, and
writes `HOT_UPDATER_API_KEY` to `envFilePath` or the default local
`.env.hotupdater`. If that file already contains one canonical key, it reuses
the key and derives the same digest rather than rotating implicitly. Provider
IaC injects only the digest as `HotUpdater.API_KEY_SHA256`; the raw key must not
appear in deployed environment variables, provider state, generated source,
command arguments, or logs. The mobile client reads the local raw key and
sends it as `x-api-key`. The runtime projects that digest into an ephemeral in-memory
Better Auth API-key session; it does not persist a Better Auth user or API-key
table in the provider database.

AWS additionally disables caching for the CloudFront behavior that reaches the
handler and ensures authenticated handler responses are `Cache-Control:
no-store`. Authentication must execute on every handler request; a cache key
that includes `x-api-key` is not an acceptable substitute.

This preset is a single-key deployment bootstrap, not a credential-management
service. A key embedded in a React Native bundle is extractable by a motivated
client. It is useful as a deployment access gate and abuse barrier, but it is
not an administrator credential, user identity, per-device secret, or
authorization boundary for privileged management APIs. Remote rotation,
overlapping keys, revocation, expiry, permission policy, recovery, and a secret
broker are explicit follow-up scope. Rotation replaces the one projected
digest, so the old and new key cannot overlap.

## Migration plan

### Stage 0: release isolation

Ship the current database-plugin-v2 and Analytics schema cohort without mixing
the kernel extraction into its forward-only migrations.

### Stage 1: kernel and first-party packages

- add the generic plugin composer to `@hot-updater/server`;
- add `@hot-updater/analytics`;
- add `@hot-updater/better-auth`, its managed preset, and its provisioning
  subpath;
- restore `HandlerOptions.routes` and `HandlerRoutes` as the only public
  built-in route option surface;
- add the monotonic protect-all contribution to the generic composer;
- expose the guarded generic database runtime to first-party feature setup;
- make `analytics()` own the default bounded provider and explicit dedicated
  provider factory;
- preserve self-hosted HTTP shapes and provider migrations while documenting
  the managed authentication policy change;
- migrate `@hot-updater/server/node` to generic lazy raw-body forwarding and
  route request policies; reject already parsed protected bodies;
- remove plugin-core's public high-level Analytics service/domain/token
  surface and neutralize server adapter names while retaining the internal raw
  persistence model and existing migrations;
- convert Cloudflare, Firebase, and Supabase managed presets to
  `plugins: [analytics(), managedBetterAuthPlugin({ apiKeySha256 })]`;
- convert AWS to
  `plugins: [managedBetterAuthPlugin({ apiKeySha256 })]`, disable handler
  caching, and provision only the digest to deployed runtime configuration;
- expose the old `routes.analytics` composition only from
  `@hot-updater/analytics/legacy-server`, whose only exports are
  `createLegacyHotUpdater` and `LegacyCreateHotUpdaterOptions`;
- add the namespaced `features.analytics` runtime API and temporary,
  collision-checked flat aliases.
- emit and pack condition-specific `.d.mts` and `.d.cts` declarations for
  every new or changed dual-format entry.

The new server entrypoint is Analytics-free in Stage 1. The legacy Analytics
bridge attaches the Analytics manifest outside the server package. Existing
root-import source compatibility is not claimed; this is a documented breaking
source migration with preserved HTTP behavior.

### Stage 2: consumer migration

- migrate standalone handling to `standaloneAnalytics(config)` at the feature
  boundary;
- keep local Console Analytics disabled by default; opt a complete generic
  database in with `"database"` or pass a branded dedicated manifest;
- migrate Console and server consumers to
  `hotUpdater.features.analytics` and `@hot-updater/analytics` types;
- remove direct `supportsAnalytics` usage from new paths;
- migrate downstream applications and framework integrations to the generic
  raw-body contract established by the Stage 1 server adapter;
- announce final removal of legacy server Analytics exports.

### Stage 3: breaking cleanup

- remove `routes.analytics`;
- remove flat Analytics API aliases;
- remove remaining transitional/internal Analytics aliases from server and
  plugin-core;
- remove Analytics route and body-limit special cases from server adapters;
- remove legacy Analytics capability symbols while preserving dedicated
  provider probes;
- remove the legacy Analytics wrapper;
- decide the final package home of the internal raw `bundle_events`
  persistence row without moving or replaying provider migrations.

The new `@hot-updater/server` entrypoint satisfies the static Analytics
boundary in Stage 1. Stage 3 removes transitional public aliases and remaining
internal persistence aliases; public high-level plugin-core Analytics
service/domain/token exports already leave in Stage 1.

### Source, export, and migration matrix

| Existing surface                                    | New owner or replacement                          | Compatibility                                                                                            |
| --------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `createHotUpdater({ routes: { analytics: true } })` | `plugins: [analytics()]`                          | Breaking source migration; legacy wrapper under `@hot-updater/analytics/legacy-server` during Stages 1-2 |
| `HandlerOptions.coreRoutes`                         | `HandlerOptions.routes: HandlerRoutes`            | Unreleased kernel branch migration; `coreRoutes` remains internal only                                   |
| Flat `getBundleEvent*` and installation methods     | `hotUpdater.features.analytics.*`                 | Generic flat aliases during Stages 1-2, then removed                                                     |
| Server Analytics types and database Analytics API   | `@hot-updater/analytics`                          | Explicit import migration                                                                                |
| Server generic DB adapters                          | Existing `@hot-updater/server/adapters/*` paths   | Preserved; adapters remain Analytics-free                                                                |
| `@hot-updater/server`, `/db`, and `/node`           | Existing paths                                    | Preserved except documented Analytics exports                                                            |
| Cloudflare `/worker`                                | Existing path                                     | Preserved                                                                                                |
| Firebase `/functions` and `/functions/handler`      | Existing paths                                    | Preserved                                                                                                |
| Supabase `/edge`                                    | Existing path                                     | Preserved                                                                                                |
| Standalone route overrides                          | `standaloneAnalytics(config)` plus existing paths | Explicit Console config migration; independent ingestion/query availability preserved                    |

Provider migration assets keep their existing package, filename, version, and
execution owner. The extraction creates no replacement migration, does not
rename or replay D1/Supabase migrations, and does not recreate Firebase
collections or indexes. Better Auth migrations are configured and run by an
application that selects the Better Auth adapter, never by Hot Updater or a
managed digest projection.

## Error model

Construction errors are typed and include stable machine-readable codes for:

- duplicate plugin ID;
- duplicate capability token ID;
- duplicate capability provider;
- missing capability;
- invalid capability;
- duplicate route ID;
- duplicate route or canonical dynamic route;
- duplicate metadata namespace;
- duplicate metadata wire key;
- duplicate API namespace or alias;
- duplicate middleware ID;
- unknown middleware dependency;
- middleware dependency cycle;
- multiple authentication providers;
- protected route without authentication;
- invalid plugin contribution.

Runtime authentication failures do not expose provider errors. Feature-specific
runtime failures are owned by the feature plugin.

## Verification gates

### Static boundary

- `@hot-updater/server` has no dependency on `@hot-updater/analytics`.
- server source and declarations contain no Analytics, BundleEvent,
  installation, `/events`, or Analytics capability identifiers from the new
  Stage 1 entrypoint onward.
- plugin-core public declarations contain no high-level Analytics service API
  or token; the temporary internal raw persistence row is not exported through
  the server feature API.
- `HandlerOptions` has no type parameter.
- `HandlerOptions.routes` is typed as `HandlerRoutes`; `coreRoutes` fails
  excess-property type checks on both public handler entrypoints.
- `routes.eventIngestion` fails excess-property type checks.
- `routes.analytics` fails excess-property type checks on the new server
  entrypoint.

### Kernel

- every permutation of a plugin set compiles to the same manifest;
- duplicate plugin, capability, route, middleware, API, and metadata ownership
  rejects;
- strict missing capabilities, unknown middleware edges, and middleware cycles
  reject;
- protected routes without authentication reject;
- multiple authentication providers reject;
- protect-all upgrades core and feature routes regardless of plugin order,
  remains idempotent under duplicate policies, and has no downgrade form;
- manifests cannot mutate after construction;
- base path is applied exactly once;
- static routes outrank parameter routes independent of registration order;
- database-backed capability operations pass through the same schema-readiness
  guard as core database operations;
- feature setup receives only the frozen, guarded generic database runtime,
  never adapter migration or schema-generation hooks;
- `analytics()` preserves its literal namespace and API type rather than
  widening to the low-level manifest contract;
- setup cannot contribute schema, migrations, lifecycle, or pre-auth hooks.

### Analytics

- omitting `analytics()` exposes no Analytics routes, metadata, runtime API, or
  Analytics member in the returned TypeScript type;
- installing `analytics()` over a bare generic database preserves all existing
  wire behavior without decorating that database;
- its provider factory receives the frozen, schema-guarded database runtime;
- a malformed explicit provider fails construction before routes or API aliases
  are published;
- request size, payload validation, scan bounds, and errors remain unchanged;
- path, method, access, request policy, parser, and handler stay in one
  Analytics-owned endpoint declaration;
- duplicate `analytics()` instances fail before setup;
- AWS/blob managed presets omit `analytics()` and emit no warning; custom
  versioned-CAS blob servers may install it explicitly;
- Cloudflare/Firebase/Supabase database plugins expose no Analytics
  contributions while their managed server presets install `analytics()` and
  protect all of its routes;
- Console preserves `.mts` and `.cts` manifest identity and uses
  `standaloneAnalytics(config)` for a dedicated remote provider, while an
  omitted Console setting installs no Analytics feature;
- standalone covers ingestion-only, query-only, both, neither, stale probe, and
  timeout behavior.

### Authentication

- missing and invalid authentication return `401`;
- authentication outage and unexpected failure fail closed;
- the authentication result cannot express an HTTP `Response`;
- the authentication input cannot consume a body;
- the request body remains unconsumed after denial;
- no later middleware, handler, database, or storage operation runs;
- principal state is isolated across concurrent requests;
- a configured Better Auth instance is used without mutation;
- Better Auth API keys become sessions only when the application configures
  `apiKey({ enableSessionForAPIKeys: true })`;
- `betterAuthPlugin({ auth })` uses only `auth.api.getSession` and has no
  Hot Updater API-key, `configId`, header, or permission option;
- a missing or invalid Better Auth session denies `/version`, update-check,
  bundle, ingestion, and query routes without invoking their handlers;
- the managed Better Auth preset accepts a valid digest-matching key, rejects
  malformed digests at construction, and denies missing or invalid keys;
- managed verification does not depend on a provider database and exposes
  neither the raw key nor its digest through metadata or errors;
- locked Better Auth outage behavior is characterized without leaking the
  provider error or secret sentinel through the adapter, kernel response, or
  Hot Updater logs;
- no path-selective `protect` or `authorize` callback can downgrade route
  access;
- a non-API-key authentication implementation passes the same contract suite.

### Adapters and managed runtimes

- Fetch/Hono and Node paths deny protected POST requests before parsing;
- adapters contain no Analytics path checks;
- adapters preserve body streams generically rather than inspecting paths;
- standalone rejects credential-bearing cross-origin destinations and
  redirects while preserving configured outbound headers;
- Cloudflare worker, Firebase emulator, and Supabase Docker integration suites
  require `x-api-key` for version, update, ingestion, and query routes;
- AWS integration tests prove the handler behavior has caching disabled,
  authenticated responses are `no-store`, and no response is served without a
  fresh authentication decision;
- managed artifact tests prove deployed configuration and generated sources
  contain only `HotUpdater.API_KEY_SHA256`, while the raw
  `HOT_UPDATER_API_KEY` remains in the local environment file;
- no provider migration is recreated, replayed, or moved;
- provisioning reuses one valid existing local key, rejects duplicate or
  malformed definitions, and never prints either credential representation.

### Package and type surface

- packed-artifact tests resolve `@hot-updater/analytics`,
  `@hot-updater/analytics/provider`, and
  `@hot-updater/analytics/legacy-server` through every advertised export
  condition;
- real extracted tarballs resolve server root and
  `/internal/first-party-plugin`, plugin-core capability authoring/enumeration,
  Analytics, Better Auth, the managed Better Auth preset, its provisioning
  subpath, and managed entrypoints in ESM and CommonJS, with matching `.d.mts`
  and `.d.cts` declarations under NodeNext and `skipLibCheck: false`;
- config-loader tests cover direct TypeScript, ESM, and CommonJS configs,
  transitive and functional CommonJS providers, concurrent evaluation,
  success/error cache restoration, and real mixed CommonJS-provider to
  ESM-Analytics/server composition without weakening the dual-format package
  maps;
- package lint and type-compatibility checks cover the published declarations;
- literal factory return types preserve the Analytics namespace and operation
  types;
- plugin omission, capability absence, duplicate namespace, and alias
  collisions have compile-time and runtime fixtures;
- no assertion-based server/client inference bridge is required.

## Deferred decisions

The following are intentionally deferred beyond the first release:

- a stable third-party feature-plugin ABI;
- generic plugin schema and migration composition;
- multiple authentication providers;
- dynamic plugin installation;
- arbitrary or unscoped API-object extension merging beyond the first-party
  namespaced feature API;
- route-level authorization and permissions;
- cross-plugin mutable services;
- plugin hot reload;
- managed multi-key rotation, overlap, revocation, expiry, recovery, and remote
  secret delivery;
- per-user or per-device authorization and any claim that a mobile-embedded key
  is non-extractable.
