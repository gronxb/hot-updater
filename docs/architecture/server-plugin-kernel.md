# Hot Updater Server Plugin Kernel

## Status

- Status: Accepted for implementation planning
- Last updated: 2026-07-24
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

The proponent and opponent first disagreed on missing-provider behavior and
the runtime API shape. The mediator selected a discriminated feature state,
default warning behavior, and an opt-in strict construction error. Later
objections about available-branch aliases and schema-readiness ordering were
accepted, incorporated, and re-reviewed to PASS. No unresolved blocker remains
in this design.

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
  provider, probe/cache, metadata, API, and bridge semantics. Provider/runtime
  owns generic guarded transport, carriers, package wiring, and managed
  presets.
- **R13 — legacy bridge:** `@hot-updater/analytics/legacy-server` exports
  exactly `createLegacyHotUpdater` and `LegacyCreateHotUpdaterOptions`. Only
  that option type recognizes `routes.analytics`; it never adds
  `routes.eventIngestion`.
- **R14 — declarations:** every new or changed dual-format entry publishes
  condition-specific `.d.mts` and `.d.cts` declarations verified from a real
  packed tarball. Package runtime maps remain condition-specific. CLI config
  evaluation instead uses a serialized, temporary canonical module cohort for
  plugin-core root/internal capability APIs and Analytics root/provider, the
  sole current feature-token owner, then restores the CommonJS cache on
  success or failure. Every future package that defines capability tokens and
  is usable from config must join this cohort and add a mixed CommonJS
  config-to-ESM runtime composition gate, or replace the bridge with an
  equivalent nominal identity substrate.

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
Analytics. A provider capability alone never mounts Analytics routes or exposes
Analytics API behavior.

Authentication is a mechanism-neutral kernel concept. A configured
authentication plugin gates protected routes before their bodies or handlers
are evaluated. API keys are not part of the kernel contract. A managed provider
may configure Better Auth with its API-key plugin as one concrete preset.

The first version keeps update check, bundle management, and `/version` as core
Hot Updater protocol surfaces. It extracts optional cross-cutting features
without turning the kernel into a general application framework.

## Reference model: Better Auth API Key

The composition style intentionally follows Better Auth's
`packages/api-key` package, version `1.6.20`, reviewed at commit
`c342f42fff46043b5e195f7f757b0f2c1043414c`. The reference is architectural,
not a copy of its authentication or persistence semantics.

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
  as kernel concepts.

Hot Updater providers retain their existing migrations, plugin order is
semantically irrelevant, and every ownership conflict is a construction error.

## Requirements

### Functional requirements

1. `createHotUpdater` accepts a set of server plugins.
2. Omitting `analytics()` removes every Analytics route, handler, runtime
   metadata contribution, and Analytics-only public type.
3. Installing `analytics()` contributes the complete Analytics HTTP feature.
4. Analytics-capable providers expose a validated capability through a generic
   provider capability carrier.
5. Providers that do not expose that capability remain valid providers.
6. Installing `analytics()` without a local provider capability succeeds with
   one construction-time warning, publishes no Analytics routes, and exposes a
   typed unavailable feature state. A strict Analytics option may instead
   require a construction error.
7. Remote standalone capability availability may remain asynchronous, but
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
    its literal missing-capability policy determines whether the installed
    namespace is an availability union or a guaranteed available API.
15. Feature plugins cannot contribute database migrations or asynchronous
    lifecycle work. Infrastructure setup and cleanup remain database and
    storage responsibilities.

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
- Plugins are trusted in-process code. The capability registry is not a
  sandbox.

## Non-goals

- A general-purpose application framework.
- Runtime plugin loading, unloading, or hot reload.
- Asynchronous route registration after `createHotUpdater` returns.
- Generic plugin-owned database migration composition.
- Deep merging arbitrary plugin metadata.
- An API-key-specific Hot Updater authentication contract.
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

Custom database and storage implementations remain supported. First-party
feature manifests establish the initial kernel contract. Third-party feature
authoring becomes supported only after a conformance suite and versioned ABI
are published.

## Current-state contradictions

The current implementation violates the target boundary in several places:

- `CreateHotUpdaterOptions` exposes `routes`, which includes
  `routes.analytics`.
- `createHandler` imports Analytics capability resolution and Analytics route
  factories.
- `HandlerAPI` and `DatabaseAPI` include Analytics APIs.
- `createDatabasePluginCore` discovers and materializes Analytics services.
- `createDatabasePlugin` automatically marks Analytics support.
- the core `/version` handler constructs Analytics metadata;
- `@hot-updater/server/node` imports the event body limit and recognizes
  `/events`;
- standalone publicly enumerates Analytics operations and probes Analytics
  fields;
- managed runtimes enable Analytics through `routes.analytics: true`.

Moving route files alone is insufficient. Every item above must leave the final
server kernel or become a generic kernel primitive.

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
`/version` remains a public, credential-invariant core route. Feature manifests
cannot override these core routes.

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
- the Analytics provider capability token and runtime validator;
- `withAnalyticsProvider(database)`, which attaches a deferred Analytics
  provider factory to a generic database capability carrier;
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

- `betterAuthPlugin({ auth })`;
- conversion from a configured Better Auth instance to the generic
  authentication result;
- Better Auth-specific error normalization.

`better-auth` remains an optional peer dependency. This package does not
construct Better Auth, configure API keys, mount `auth.handler`, or own Better
Auth schema migrations.

### Provider packages

Cloudflare, Firebase, Supabase, AWS, and custom providers retain ownership of:

- provider schema and migrations;
- database and storage credentials;
- provider contexts;
- infrastructure provisioning;
- optional Analytics provider implementations;
- optional managed authentication presets.

Moving Analytics code does not move or replay provider database migrations.

`@hot-updater/server/adapters/{drizzle,kysely,mongodb,prisma}` remain generic
and never attach the Analytics token. A self-hosted consumer opts in at the
Analytics boundary:

```typescript
const database = withAnalyticsProvider(prismaAdapter(options));
```

Cloudflare, Firebase, and Supabase apply the same wrapper inside their managed
packages. AWS and blob-backed providers do not gain the capability unless they
deliberately implement and attach the Analytics provider contract.

## Public composition

```typescript
import { analytics } from "@hot-updater/analytics";
import { withAnalyticsProvider } from "@hot-updater/analytics/provider";
import { betterAuthPlugin } from "@hot-updater/better-auth";
import { createHotUpdater } from "@hot-updater/server";
import { prismaAdapter } from "@hot-updater/server/adapters/prisma";

const hotUpdater = createHotUpdater({
  database: withAnalyticsProvider(prismaAdapter(databaseOptions)),
  storages,
  plugins: [analytics(), betterAuthPlugin({ auth })],
  basePath: "/api/check-update",
});

const analyticsFeature = hotUpdater.features.analytics;

if (analyticsFeature.status === "available") {
  await analyticsFeature.getBundleEventSummary(input);
}
```

The same Analytics-capable database without `analytics()` exposes no Analytics
behavior or Analytics runtime API:

```typescript
const hotUpdater = createHotUpdater({
  database: analyticsCapableDatabase,
  plugins: [],
});
```

During the managed compatibility stage, Cloudflare, Firebase, and Supabase
spell their current public-query policy explicitly:

```typescript
createHotUpdater({
  database: managedAnalyticsDatabase,
  plugins: [
    analytics({
      queryAccess: "public",
      missingCapability: "error",
    }),
  ],
});
```

No no-op authenticator or `authorize: () => true` is installed. When a managed
authentication preset is ready, that provider changes to the protected default
and installs `betterAuthPlugin({ auth })` in the same release.

### Public option and return types

`HandlerOptions` is deliberately non-generic. Platform context typing belongs
to `CreateHotUpdaterOptions`, not the HTTP route composer.

```typescript
export interface HandlerOptions {
  readonly basePath?: string;
  readonly coreRoutes?: {
    readonly updateCheck?: boolean;
    readonly bundles?:
      | false
      | true
      | {
          readonly access: HotUpdaterRouteAccess;
        };
  };
}

export interface CreateHotUpdaterOptions<TContext> extends HandlerOptions {
  readonly database: DatabasePlugin;
  readonly storages?: readonly RuntimeStoragePlugin<TContext>[];
  readonly plugins?: readonly FirstPartyFeatureManifest[];
}
```

`GET /version` is always public. Update check is public and enabled by default.
Bundle management is disabled by default; when enabled in the new API it is
protected unless the deployment explicitly declares public compatibility
access.

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
object, never the widened first-party manifest array. Available branches carry
their required transitional aliases; unavailable branches carry none, so
narrowing the feature state also narrows alias presence. `analytics()` has
fixed plugin ID and namespace `"analytics"` and the package version as its
manifest version; none can be overridden through options. `analytics()`
accepts one normalized configuration object, not a configuration array or
fallback ID. Two instances fail with `DUPLICATE_PLUGIN_ID` before setup.

The Analytics factory preserves the literal missing-capability policy:

```typescript
export interface AnalyticsOptions {
  readonly queryAccess?: "protected" | "public";
  readonly missingCapability?: "warn" | "error";
}

export type AnalyticsFeatureUnavailable = Readonly<{
  status: "unavailable";
  reason: "missing-provider-capability";
}>;

export type AnalyticsFeatureAvailable = Readonly<
  AnalyticsAPI & {
    status: "available";
  }
>;

export type AnalyticsFeature =
  | AnalyticsFeatureAvailable
  | AnalyticsFeatureUnavailable;
```

`analytics()` defaults to protected query access and the `"warn"`
missing-capability policy, and carries `AnalyticsFeature`. A literal
`analytics({ missingCapability: "error" })` carries
`AnalyticsFeatureAvailable`; if the capability is absent, construction throws
before a handler is returned. A widened `"warn" | "error"` option is inferred
as the safe union.

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
authentication provider and do not invoke one. The kernel, not the
authentication plugin, decides whether a matched route is protected.

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
9. Collect feature APIs and transitional aliases; reject ownership conflicts.
10. Collect metadata projections; reject namespace and wire-key conflicts.
11. Select exactly zero or one authentication provider.
12. Reject protected routes when no authentication provider is installed.
13. Compile the post-auth middleware DAG.
14. Freeze every route, middleware, capability, metadata, and API manifest.
15. Return the runtime handler, core API, and plugin-inferred `features` API.

Setup failures, strict missing capabilities, invalid advertised capabilities,
invalid contributions, middleware dependency cycles, unknown middleware
edges, and ownership collisions are typed construction errors. A continue-mode
missing capability is an explicit unavailable contribution, never silent
deduplication or partial feature mounting. No first-wins, last-wins, or
array-order behavior is permitted.

## Analytics composition

`analytics()`:

1. validates, normalizes, and freezes its options in the factory;
2. returns the concrete literal manifest with fixed ID, namespace, and package
   version without widening away its API type;
3. requests the Analytics provider token from
   `@hot-updater/analytics/provider` using the normalized missing-capability
   policy;
4. validates every advertised provider value before setup;
5. in warn mode, represents a missing provider as a frozen unavailable feature,
   emits one warning, and contributes no Analytics route or flat API alias;
6. with a valid provider, contributes ingestion and query routes;
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

Warn-mode capability absence contributes only:

```json
{
  "analytics": false,
  "eventIngestion": false,
  "analyticsQueries": false
}
```

It does not publish `mode`, `maxMatchingRows`, an Analytics handler, a
transitional flat API alias, or a fake method that throws. Malformed advertised
capabilities and duplicate providers are configuration errors in both modes.
Strict missing capability is `MISSING_CAPABILITY`.

The public configuration does not gain `routes.eventIngestion`.

For an intentionally public, self-hosted Analytics deployment, the Analytics
plugin receives `analytics({ queryAccess: "public" })`. Managed providers use
that explicit override only for the compatibility stage. Protected routes are
never silently downgraded because an authentication provider is absent.

`withAnalyticsProvider(database)` attaches a synchronous factory but does not
instantiate an operational provider immediately. The kernel first creates the
same guarded database runtime used by core operations, then passes it to the
factory. Every Analytics database call therefore crosses the existing schema
readiness guard. The wrapper does not run migrations, inspect a remote server,
or make network calls during plugin setup. The server's generic Prisma,
Drizzle, Kysely, and Mongo adapters never attach the token themselves.

For standalone, construction validates only the attached capability shape.
Remote ingestion and query availability are resolved independently at request
and metadata time with the existing 30-second fresh cache, 5-minute bounded
stale fallback, and 5-second timeout. An unavailable or indeterminate
operation fails closed without disabling an independently available operation.

## Better Auth composition

`betterAuthPlugin` receives a configured Better Auth instance. Its default
operation is:

1. receive the already matched route and defensive copy of the request head;
2. ask the configured Better Auth instance for its authentication result;
3. normalize a valid session to a validated `HotUpdaterPrincipal`;
4. return only `anonymous`, `authenticated`, or `unavailable`.

The actual adapter receives the body-less authentication input, not a
body-capable `Request`. It cannot choose which routes are protected and cannot
return an HTTP response. The adapter does not infer or require API-key support.
There is no `protect` or `authorize` option.

The kernel's status guarantee is exact for provider-classified results. Better
Auth's public session API may collapse an internal dependency failure to the
same `null` used for an absent session, which an adapter cannot disambiguate.
Locked-version fault injection also proves that Better Auth 1.6.24 catches a
session-store error carrying `status: 503` and surfaces an `APIError` with
`status: "INTERNAL_SERVER_ERROR"` and `statusCode: 500`. The adapter therefore
maps `null` to `anonymous`, only still-classified observable outage errors to
`unavailable`, and classification-erased or otherwise unexpected throws to the
kernel's opaque `500`. A swallowed outage remains fail-closed as `401`; a
classification-erased outage remains fail-closed as `500`. These are
documented provider-library limitations and deferred upstream issues, not
claimed exact-`503` cases. A generic non-Better-Auth provider must exercise the
exact `unavailable` to `503` conformance branch. No health-preflight workaround
is introduced. Better Auth 1.6.24's default logger receives the original store
error before its public API rewrites that error. The adapter neither receives
nor re-logs that original value, and it cannot safely mutate the caller's
configured Better Auth instance. Deployments with strict log-secrecy
requirements must therefore disable or sanitize the Better Auth dependency
logger when constructing that instance.

A managed preset may configure Better Auth with API-key support and provide the
resulting configured instance to the same adapter. Bootstrap, secret delivery,
rotation, revocation, and Better Auth migrations remain provider/IaC
responsibilities.

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
mandatory before a managed preset relies on rotating standalone credentials.
At that point it owns sensitive authentication headers and route overrides
cannot replace them.

The standalone Analytics provider retains its bounded cache, stale fallback,
timeout, and independent ingestion/query availability. These semantics move
behind the Analytics provider capability and Analytics metadata resolver.
Analytics owns those operation/probe/cache semantics. The standalone package
owns one generic guarded transport, capability-carrier wiring, route
configuration, and outbound credential enforcement; it does not reimplement
Analytics parsing or availability rules.

## Managed provider policy

Managed Analytics defaults remain behavior-compatible during extraction:

- Cloudflare, Firebase, and Supabase explicitly install
  `analytics({ queryAccess: "public", missingCapability: "error" })`;
- AWS/blob providers remain Analytics-off unless they supply the provider
  capability and install the feature.

Managed Better Auth API-key authentication is staged per provider rather than
enabled universally in the kernel release.

Before a managed provider claims API-key support, it must provide:

- idempotent first bootstrap;
- one-time secret delivery without logs or source generation;
- hashed server-side verification material;
- least-privilege keys;
- explicit expiration and revocation;
- overlap rotation with old and new keys;
- recovery when the active management credential is lost;
- end-to-end tests for bootstrap, authentication, rotation, and revocation.

Update checks and event ingestion remain public in the default managed policy.
Analytics queries remain explicitly public only during the compatibility
stage. Bundle management and Analytics queries use protected route manifests
when a managed authentication preset is enabled. A key embedded in a React
Native application is not treated as a management secret.

## Migration plan

### Stage 0: release isolation

Ship the current database-plugin-v2 and Analytics schema cohort without mixing
the kernel extraction into its forward-only migrations.

### Stage 1: kernel and first-party packages

- add the generic plugin composer to `@hot-updater/server`;
- add `@hot-updater/analytics`;
- add `@hot-updater/better-auth`;
- introduce the generic provider capability carrier;
- add `withAnalyticsProvider` and migrate capable provider packages to it;
- preserve current HTTP behavior and provider migrations;
- migrate `@hot-updater/server/node` to generic lazy raw-body forwarding and
  route request policies; reject already parsed protected bodies;
- remove plugin-core's public high-level Analytics service/domain/token
  surface and neutralize server adapter names while retaining the internal raw
  persistence model and existing migrations;
- convert managed presets to
  `plugins: [analytics({ queryAccess: "public", missingCapability: "error" })]`;
- expose the old `routes.analytics` composition only from
  `@hot-updater/analytics/legacy-server`, whose only exports are
  `createLegacyHotUpdater` and `LegacyCreateHotUpdaterOptions`;
- add the namespaced `features.analytics` runtime API and temporary,
  collision-checked flat aliases.
- emit and pack condition-specific `.d.mts` and `.d.cts` declarations for
  every new or changed dual-format entry.

The new server entrypoint is Analytics-free in Stage 1. The legacy Analytics
wrapper attaches the provider capability and Analytics manifest outside the
server package. Existing root-import source compatibility is not claimed; this
is a documented breaking source migration with preserved HTTP behavior.

### Stage 2: consumer migration

- migrate standalone capability handling to the Analytics provider boundary;
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
- remove legacy Analytics capability symbols and probes;
- remove the legacy Analytics wrapper;
- decide the final package home of the internal raw `bundle_events`
  persistence row without moving or replaying provider migrations.

The new `@hot-updater/server` entrypoint satisfies the static Analytics
boundary in Stage 1. Stage 3 removes transitional public aliases and remaining
internal persistence aliases; public high-level plugin-core Analytics
service/domain/token exports already leave in Stage 1.

### Source, export, and migration matrix

| Existing surface                                    | New owner or replacement                             | Compatibility                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `createHotUpdater({ routes: { analytics: true } })` | `analytics()` plus `withAnalyticsProvider(database)` | Breaking source migration; legacy wrapper under `@hot-updater/analytics/legacy-server` during Stages 1-2 |
| Flat `getBundleEvent*` and installation methods     | `hotUpdater.features.analytics.*`                    | Generic flat aliases during Stages 1-2, then removed                                                     |
| Server Analytics types and database Analytics API   | `@hot-updater/analytics`                             | Explicit import migration                                                                                |
| Server generic DB adapters                          | Existing `@hot-updater/server/adapters/*` paths      | Preserved; adapters remain Analytics-free                                                                |
| `@hot-updater/server`, `/db`, and `/node`           | Existing paths                                       | Preserved except documented Analytics exports                                                            |
| Cloudflare `/worker`                                | Existing path                                        | Preserved                                                                                                |
| Firebase `/functions` and `/functions/handler`      | Existing paths                                       | Preserved                                                                                                |
| Supabase `/edge`                                    | Existing path                                        | Preserved                                                                                                |
| Standalone route overrides                          | Existing paths and behavior                          | Preserved, including independent ingestion/query availability                                            |

Provider migration assets keep their existing package, filename, version, and
execution owner. The extraction creates no replacement migration, does not
rename or replay D1/Supabase migrations, and does not recreate Firebase
collections or indexes. Better Auth migrations are configured and run by the
application or managed-provider IaC, never by Hot Updater.

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

The default Analytics missing-provider path is not an error. It emits
`ANALYTICS_PROVIDER_CAPABILITY_MISSING` exactly once for that construction,
states that Analytics routes and runtime operations are disabled, and contains
no dynamic provider or credential detail.

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
- manifests cannot mutate after construction;
- base path is applied exactly once;
- static routes outrank parameter routes independent of registration order;
- database-backed capability operations pass through the same schema-readiness
  guard as core database operations;
- `analytics()` preserves its literal namespace and API type rather than
  widening to the low-level manifest contract;
- setup cannot contribute schema, migrations, lifecycle, or pre-auth hooks.

### Analytics

- omitting `analytics()` exposes no Analytics routes, metadata, runtime API, or
  Analytics member in the returned TypeScript type;
- installing `analytics()` with a valid provider preserves all existing wire
  behavior;
- default/warn mode without a local provider capability succeeds with exactly
  one warning, no Analytics routes or aliases, false availability metadata, and
  a frozen unavailable feature state;
- default/warn mode with a valid provider yields the available union branch;
- literal strict mode with a valid provider yields a non-union available API;
- strict mode without a local provider capability fails with
  `MISSING_CAPABILITY`;
- malformed advertised and duplicate capabilities fail in both modes;
- request size, payload validation, scan bounds, and errors remain unchanged;
- path, method, access, request policy, parser, and handler stay in one
  Analytics-owned endpoint declaration;
- duplicate `analytics()` instances fail before setup;
- AWS/blob managed presets omit `analytics()` and emit no warning;
- Cloudflare/Firebase/Supabase packed presets use strict mode, and removing
  their provider wrapper fails construction;
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
- locked Better Auth outage behavior is characterized without leaking the
  provider error or secret sentinel through the adapter, kernel response, or
  Hot Updater logs;
- no `protect` or `authorize` callback can downgrade route access;
- a non-API-key authentication implementation passes the same contract suite.

### Adapters and managed runtimes

- Fetch/Hono and Node paths deny protected POST requests before parsing;
- adapters contain no Analytics path checks;
- adapters preserve body streams generically rather than inspecting paths;
- standalone rejects credential-bearing cross-origin destinations and
  redirects while preserving configured outbound headers;
- Cloudflare worker, Firebase emulator, and Supabase Docker integration suites
  preserve observable route behavior;
- no provider migration is recreated, replayed, or moved;
- managed authentication bootstrap and rotation pass provider-specific E2E
  before being enabled.

### Package and type surface

- packed-artifact tests resolve `@hot-updater/analytics`,
  `@hot-updater/analytics/provider`, and
  `@hot-updater/analytics/legacy-server` through every advertised export
  condition;
- real extracted tarballs resolve server root and
  `/internal/first-party-plugin`, plugin-core capability authoring/enumeration,
  Analytics, Better Auth, and managed entrypoints in ESM and CommonJS, with
  matching `.d.mts` and `.d.cts` declarations under NodeNext and
  `skipLibCheck: false`;
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
- plugin hot reload.
