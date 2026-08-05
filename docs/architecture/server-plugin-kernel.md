# Generic Server Kernel

## Scope

The server kernel composes four generic extension points:

1. versioned infrastructure capabilities;
2. explicitly declared HTTP routes; and
3. one mechanism-neutral authentication provider; and
4. an optional monotonic route-access policy.

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
4. run each plugin setup once and collect every route and route policy;
5. apply route policies to the collected routes;
6. compile the core and contributed routes; and
7. select the authentication provider.

Capability factories, parsers, and plugin setup must not return promises or
thenables. Duplicate plugin IDs, capability IDs or providers, route IDs or
patterns, and authentication providers fail construction. A protected route
without an authentication provider also fails construction.

Capability factories receive schema-readiness-guarded database operations and
runtime-only storage access. They do not receive migration factories, provider
configuration, profiles, or credentials.

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

The kernel preserves the existing server contract:

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
