# Hot Updater Server with Hono + PGlite

A production-ready Hot Updater server example using:
- **Hono** - Fast web framework
- **PGlite** - Lightweight PostgreSQL in Node.js (no server required)
- **Kysely** - Type-safe SQL query builder
- **Hot Updater schema migrations** - Versioned schema setup through the CLI

## Features

- ✅ No PostgreSQL server needed (uses PGlite)
- ✅ File-based persistence
- ✅ Versioned schema migrations through the CLI
- ✅ RESTful API endpoints
- ✅ CORS enabled
- ✅ Request logging
- ✅ Graceful shutdown

## Setup

1. Install the workspace dependencies and enter this package:
```bash
pnpm install
cd examples-server/hono-kysely-pglite
```

2. Copy the environment template to the path loaded by `src/db.ts` and replace
   its authentication, signing, and R2 credential placeholders:
```bash
cp .env.example src/.env.hotupdater
```

3. Apply the Hot Updater schema. Startup does not run migrations automatically:
```bash
pnpm exec hot-updater db migrate src/db.ts --yes
```

4. Start the development server:
```bash
pnpm dev
```

The server will start on http://localhost:3000

## API Endpoints

### Health Check
```bash
GET /
```

### Check for Updates
```bash
GET /hot-updater/release-catalogs/app-version/:authorityId/:platform/:channelKey/:appVersion
GET /hot-updater/release-catalogs/fingerprint/:authorityId/:platform/:channelKey/:fingerprintHash
```

`channelKey` is the base64url-encoded channel key produced by the client.

Admin routes under `/hot-updater/admin/*` require
`Authorization: Bearer <HOT_UPDATER_ADMIN_TOKEN>`. Missing or mismatched
credentials are rejected.

### List Bundles
```bash
GET /hot-updater/admin/bundles?limit=50
```

### Create Bundle
```bash
POST /hot-updater/admin/bundles
```

### Delete Bundle
```bash
DELETE /hot-updater/admin/bundles/:id
```

### List Channels
```bash
GET /hot-updater/admin/channels
```

## Project Structure

```
hono-server/
├── src/
│   ├── index.ts      # Main server entry point
│   ├── db.ts         # Database setup (PGlite + Kysely + Hot Updater schema)
│   └── routes.ts     # API routes
├── data/             # PGlite database files (gitignored)
├── package.json
└── tsconfig.json
```

## Database

The server uses PGlite with file-based storage in `./data`.
The database schema is generated from Hot Updater's versioned schema and
migrated through the Hot Updater CLI.

Run `pnpm exec hot-updater db migrate src/db.ts --yes` before first use and
whenever the checked-in schema changes.

## Storage Configuration

The example uses the AWS plugin against Cloudflare R2's S3-compatible endpoint.
Configure these values in `src/.env.hotupdater`:

```env
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
R2_BUCKET_NAME=your-r2-bucket-name
HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY=replace-with-a-long-random-signing-key
HOT_UPDATER_ADMIN_TOKEN=replace-with-a-long-random-token
```

You can also use other storage providers by modifying `src/db.ts`.

## Production

Apply migrations as a release step, then build and start the emitted entry:

```bash
pnpm exec hot-updater db migrate src/db.ts --yes
pnpm build
node dist/src/index.js
```

The compiled module does not load the source-tree `src/.env.hotupdater` file.
Supply the port, authentication token, signing key, and R2 credentials through
the deployment environment or process manager.
