# Generic Server Kernel

## Scope

The server kernel composes five generic extension points:

1. versioned infrastructure capabilities;
2. explicitly declared HTTP routes;
3. one mechanism-neutral authentication provider;
4. an optional monotonic route-access policy; and
5. versioned universal component schemas bound to a provider-neutral data
   adapter.

It does not define Analytics, authentication products, managed deployment
policy, provider presets, or storage contracts.

## Package boundaries

`@hot-updater/plugin-core` publicly owns capability tokens and immutable
capability attachment. Custom database and storage providers may attach a
capability to their configured runtime object. Shared token creation and
capability enumeration remain internal implementation details.

`@hot-updater/server` accepts opaque server plugins through the `plugins`
option. Server plugin authoring is limited to the unsupported
`@hot-updater/server/internal/first-party-plugin` entry until first-party
features validate the contract. The supported root does not export a general
server plugin factory.

A feature plugin owns its component ID, schema history, table and access
pattern names, structured row constraints, and declarative legacy-adoption
policy. A database provider only implements the generic component adapter
contract. Provider source must not import feature packages or reproduce their
schema constants. This keeps the fixed core database model map separate from
append-oriented feature data.

All application, provider, plugin, preload, and internal-entrypoint code in the
same JavaScript process is trusted. The process authorities coordinate nominal
identity across ESM, CommonJS, and bundled module instances and prevent
accidental structural counterfeits after initialization. They are not an
authentication boundary, authorization mechanism, or sandbox for hostile
same-process code.

## Construction

Construction is synchronous and deterministic:

1. validate and sort plugins by ID;
2. collect and validate capability providers;
3. materialize and parse capabilities against a frozen infrastructure view;
4. collect component schemas, reject component/table collisions, and bind them
   to the component data adapter;
5. run each plugin setup once and collect every route and route policy;
6. apply route policies to the collected routes;
7. compile the core and contributed routes; and
8. select the authentication provider.

Capability factories, parsers, and plugin setup must not return promises or
thenables. Duplicate plugin IDs, capability IDs or providers, route IDs or
patterns, and authentication providers fail construction. A protected route
without an authentication provider also fails construction.

Capability factories receive schema-readiness-guarded database operations and
runtime-only storage access. They do not receive migration factories, provider
configuration, profiles, or credentials.

Component binding is synchronous and side-effect free. It cannot create tables,
write schema markers, or deploy indexes. Migration and generated artifacts are
administrative operations exposed through the DB tooling boundary. Runtime
append and ordered-scan operations fail closed until the provider confirms the
latest declared component version is ready.

Migration classifies physical storage against every declared schema version,
then applies the shared `ready`, `create`, `adopt`, `migrate`, or `reject`
decision. Providers compile storage-enforced named checks and supported
nullable/index changes to their native storage. Validation-only checks remain
part of the same portable row contract without changing a legacy physical
fingerprint. Providers validate the final physical shape and every stored row
against both check kinds before recording the component marker. The marker
write is last; future markers, unknown legacy evidence, physical drift, and
invalid rows fail closed. Provider-specific concerns such as RLS, Firestore
composite indexes, or DynamoDB layout markers remain generic provider envelopes
around that logical contract.

`migrateUniversalComponents(hotUpdater)` executes provider migration hooks in
component-ID order. `generateUniversalComponentArtifacts(hotUpdater)` returns
version-tagged provider artifacts with their owning component ID and rejects
stale target versions or output-path collisions. Both functions live only under
`@hot-updater/server/db`; neither is part of the request-time root API.

## Request lifecycle

The runtime matches a route before authentication. Public routes skip
authentication. Protected routes authenticate from defensive copies of the
request method, URL, headers, signal, and matched route metadata. Route input
parsing and handling begin only after successful authentication.

Anonymous, unavailable, malformed, and failed authentication resolve to
opaque `401`, `503`, `500`, and `500` responses. Every protected response is
`Cache-Control: private, no-store`.

The Node adapter keeps parsed Express bodies compatible but serializes them
lazily. Hot Updater therefore does not read or serialize a protected body
before authentication. To guarantee authentication before transport bytes are
consumed, mount `toNodeHandler` before general framework body parsers.

## Core compatibility

Without a contributed route policy, the kernel preserves the existing server
contract:

- `/version` and OTA update-check routes are public;
- update-check routes remain enabled by default;
- bundle management routes remain disabled by default;
- `routes.bundles: true` retains its existing public behavior;
- `/version` returns exactly `{ version }`;
- full and framework-stripped base paths remain accepted; and
- `database`, `storages`, deprecated `storagePlugins`, `basePath`, `cwd`, and
  `routes` keep their existing types and precedence.

Installing an authentication provider does not change any core route access.
An internal first-party contribution may opt into the generic `protect-all` or
`protect-except-core` policy. Policies only upgrade route access, and a core
exception applies only to an actual core-origin route with that ID. The kernel
does not select a managed policy or install a policy by default.

## Non-goals

This kernel does not include feature API projection, version metadata,
middleware composition, Analytics persistence or routes, Better Auth, API
keys, managed provisioning, provider adoption, automatic feature-policy
pairing, or policy-default selection.
