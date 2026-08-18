# Hot Updater Console

The Console is the TanStack Start management UI shipped with Hot Updater. It
loads the project's `hot-updater.config.ts` on the server and operates on the
configured database and storage plugins.

## Current capabilities

- **Release management**: filter Releases by Bundle, channel, platform, target
  app version, and enabled state; inspect catalog reachability; update policy;
  preflight changes; copy or move a Release; and delete Releases.
- **Channel management**: list, create, and delete channels.
- **Bundle inspection and cleanup**: inspect Bundle metadata, patch children,
  and analytics activity. The storage-aware deletion path removes database
  rows and the Bundle, manifest, patch, and eligible asset objects.
- **Analytics**: show active installations, Bundle distribution, configured
  rollout state, and applied/recovered outcomes for selectable time windows.
- **Installation history**: search by install ID or user identity and inspect
  the paginated event history for a selected installation.
- **Client access keys**: create, list, and revoke client keys. Raw key material
  is returned only when a key is created; persisted hashes are never sent to
  the browser.

Analytics and access-key navigation are capability-driven. Analytics is shown
only when the configured database exposes an analytics model with bounded
query support. Access-key management is shown only when the database exposes
the complete client-access-key model. Unsupported routes redirect to the
Bundle list rather than pretending the feature is available.

## Development

Install dependencies from the monorepo root:

```bash
pnpm install
```

Then run the Console package:

```bash
pnpm --filter @hot-updater/console dev
```

The development server listens on `http://localhost:3000`. The checked-in
`packages/console/hot-updater.config.ts` supplies deterministic mock data for
local development and tests.

Useful package commands are:

```bash
pnpm --filter @hot-updater/console test:type
pnpm --filter @hot-updater/console test
pnpm --filter @hot-updater/console build
pnpm --filter @hot-updater/console preview
```

## Configuration contract

At startup, `src/lib/server/config.server.ts` loads the nearest
`hot-updater.config.ts` through `@hot-updater/cli-tools`. The Console requires:

- a database repository with Bundle, Channel, Release, and Release Catalog
  models;
- a storage plugin implementing `get`, `put`, `exists`, and `delete` for
  downloads and cleanup;
- optional analytics and client-access-key models for their corresponding UI
  sections.

Configuration and provider credentials stay server-side. React components call
TanStack Start server functions; they do not import provider SDKs or secrets.

## Routes

| Route                             | Responsibility                                                                |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `/`                               | Release-oriented Bundle list, filters, channel management, and Release editor |
| `/analytics`                      | Active installations, distribution, rollout context, and update outcomes      |
| `/installations`                  | Installation search and event history                                         |
| `/access-keys`                    | Client access-key creation, listing, and revocation                           |
| `/api/bundles/:bundleId/download` | Server-side Bundle archive download                                           |

The UI label remains **Bundles**, while each row is backed by a Release joined
to its Bundle and Release Catalog state. Release policy mutations use the
database plugin's Release APIs rather than the removed legacy
`updateBundle`-style UI flow.

## Server functions and data flow

- `src/lib/api-rpc.ts` implements Release, Channel, Bundle, catalog diagnostic,
  installation, and storage-aware deletion server functions.
- `src/lib/analytics-rpc.ts` detects analytics capability and builds the
  overview from the analytics provider plus Bundle, Release, and Channel data.
- `src/lib/access-keys-rpc.ts` implements capability detection and key
  create/list/revoke operations while removing hashes from browser responses.
- `src/lib/api.ts`, `src/lib/analytics-api.ts`, and
  `src/lib/access-keys-api.ts` expose TanStack Query options and mutations to
  the routes and components.
- `src/lib/server/runtime.server.ts` adapts optional database analytics and
  access-key models to the Console's server-side operations.

The main flow is:

1. A route validates URL search state and requests data through TanStack Query.
2. A server function loads the cached project configuration.
3. The database, analytics, access-key, or storage operation runs on the
   server.
4. A successful mutation invalidates the affected query keys so the UI reloads
   current Release, Bundle, Channel, analytics, or key state.

## Source layout

```text
src/
├── routes/
│   ├── index.tsx                  # Release-oriented Bundle list
│   ├── analytics.tsx              # Analytics overview
│   ├── installations.tsx          # Installation search and history
│   ├── access-keys.tsx            # Client access-key management
│   └── api/bundles/$bundleId/
│       └── download.ts            # Bundle download endpoint
├── components/
│   ├── features/releases/         # Release editing and policy state
│   ├── features/bundles/          # Bundle metadata, patches, and activity
│   ├── features/channels/         # Channel management
│   ├── features/analytics/        # Analytics and installation UI
│   ├── features/access-keys/      # Client access-key UI
│   └── ui/                        # Shared UI primitives
├── lib/
│   ├── api-rpc.ts                 # Core server functions
│   ├── analytics-rpc.ts           # Analytics server functions
│   ├── access-keys-rpc.ts         # Access-key server functions
│   ├── api.ts                     # Core query hooks and mutations
│   └── server/                    # Config, deletion, and Release helpers
├── router.tsx
└── styles.css
```

## Testing and contribution notes

- Keep provider access and secrets in server-only modules.
- Add meaningful tests for capability gates, Release mutations, destructive
  Bundle cleanup, analytics calculations, and URL search-state behavior.
- Run both `test:type` and `test` before submitting Console changes.
- Follow `packages/console/DESIGN.md` for terminology, layout, responsive
  behavior, and analytics presentation rules.
