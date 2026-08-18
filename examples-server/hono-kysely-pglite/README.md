# Hot Updater Server with Hono, Kysely, and PGlite

This example runs a self-hosted Hot Updater server with Hono, a persistent
PGlite database, Kysely, and Cloudflare R2 storage. It enables update checks,
bundle management, and analytics queries.

## Setup

1. Install the monorepo dependencies from the repository root:

   ```bash
   pnpm install
   ```

2. Create the environment file loaded by `src/db.ts`:

   ```bash
   cd examples-server/hono-kysely-pglite
   cp .env.example src/.env.hotupdater
   ```

   Replace every placeholder. `HOT_UPDATER_AUTH_TOKEN` protects management
   routes, and `HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY` signs R2 download URLs.

3. Apply the Hot Updater schema to a fresh or upgraded database:

   ```bash
   pnpm exec hot-updater db migrate src/db.ts --yes
   ```

4. Start the development server:

   ```bash
   pnpm dev
   ```

The server listens on `http://localhost:3000` by default. PGlite stores its
files in `./data`; starting the server does not run migrations automatically.

## Routes and authentication

The health check is public:

```text
GET /
```

Update-check routes are also public in this example. The current v1 server
uses Release Catalog routes:

```text
GET /hot-updater/release-catalogs/app-version/:authorityId/:platform/:channelKey/:appVersion
GET /hot-updater/release-catalogs/fingerprint/:authorityId/:platform/:channelKey/:fingerprintHash
GET /hot-updater/artifacts/:targetBundleId/from/:currentBundleId
```

`channelKey` is the base64url-encoded channel key produced by the client.

All routes under `/hot-updater/api/*` require the exact header
`Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>`. A missing configured token,
a missing header, or a mismatched token returns `401`.

```bash
curl \
  -H "Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>" \
  http://localhost:3000/hot-updater/api/channels
```

The current v1 management surface is:

| Method                   | Path                                                  | Purpose                           |
| ------------------------ | ----------------------------------------------------- | --------------------------------- |
| `GET`, `POST`            | `/hot-updater/api/channels`                           | List or create channels           |
| `DELETE`                 | `/hot-updater/api/channels/:id`                       | Delete a channel                  |
| `GET`, `POST`            | `/hot-updater/api/bundles`                            | List or create Bundles            |
| `GET`, `PATCH`, `DELETE` | `/hot-updater/api/bundles/:id`                        | Read, update, or delete a Bundle  |
| `GET`                    | `/hot-updater/api/releases`                           | List Releases                     |
| `GET`, `PATCH`, `DELETE` | `/hot-updater/api/releases/:id`                       | Read, update, or delete a Release |
| `POST`                   | `/hot-updater/api/releases/:id/preflight`             | Validate a Release change         |
| `GET`                    | `/hot-updater/api/release-catalogs`                   | List Release Catalog rows         |
| `GET`                    | `/hot-updater/api/release-catalogs/:scopeKey`         | Read a Release Catalog row        |
| `POST`                   | `/hot-updater/api/release-catalogs/:scopeKey/rebuild` | Rebuild a Release Catalog row     |
| `POST`                   | `/hot-updater/api/database/commit`                    | Commit a database change set      |

Analytics ingestion is mounted at `POST /hot-updater/events`. Authenticated
analytics queries are mounted at:

```text
GET /hot-updater/api/bundles/:id/events/summary
GET /hot-updater/api/bundles/:id/events/analytics
GET /hot-updater/api/installations/overview
GET /hot-updater/api/installations/active
GET /hot-updater/api/installations
GET /hot-updater/api/installations/:installId/events
```

### v0 route differences

The v0 branch uses the legacy Bundle contract. Its public update-check paths
are:

```text
GET /hot-updater/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId
GET /hot-updater/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId/:cohort
GET /hot-updater/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId
GET /hot-updater/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId/:cohort
```

Its management routes are `/hot-updater/api/bundles`,
`/hot-updater/api/bundles/:id`, and
`/hot-updater/api/bundles/channels`; it does not expose the v1 Release or
Release Catalog management routes. Use the example source from the matching
branch—the current NEXT source mounts only the v1 routes listed above.

## Storage configuration

The example registers mock storage first for local fixtures and Cloudflare R2
for real artifacts. `src/.env.hotupdater` uses these names:

```env
CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
R2_BUCKET_NAME=your-r2-bucket-name
HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY=replace-with-a-long-random-signing-key
HOT_UPDATER_AUTH_TOKEN=replace-with-a-long-random-token
```

## Project structure

```text
hono-kysely-pglite/
├── src/
│   ├── .env.hotupdater # Local environment file (gitignored)
│   ├── db.ts           # PGlite, Kysely, storage, and Hot Updater setup
│   ├── index.ts        # Hono server entry point
│   └── routes.ts       # Management auth and Hot Updater route mount
├── data/               # PGlite database directory (gitignored)
├── .env.example
├── package.json
└── tsconfig.json
```

## Production

Apply migrations as a release step, then build and start the compiled server:

```bash
pnpm exec hot-updater db migrate src/db.ts --yes
pnpm build
node dist/src/index.js
```

The compiled module does not load the source-tree `src/.env.hotupdater` file.
Supply `PORT`, the management token, and R2 credentials through the deployment
environment or process manager instead of copying secrets into `dist`.
