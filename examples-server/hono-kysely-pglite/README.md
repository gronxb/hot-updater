# Hot Updater Server with Hono + PGlite

A production-ready Hot Updater server example using:
- **Hono** - Fast web framework
- **PGlite** - Lightweight PostgreSQL in Node.js (no server required)
- **Kysely** - Type-safe SQL query builder
- **Hot Updater schema migrations** - Versioned schema setup through the CLI

## Features

- ✅ No PostgreSQL server needed (uses PGlite)
- ✅ File-based persistence
- ✅ Explicit schema migration
- ✅ RESTful API endpoints
- ✅ CORS enabled
- ✅ Request logging
- ✅ Graceful shutdown

## Setup

1. Install dependencies:
```bash
pnpm install
```

2. Configure environment variables:
```bash
cp .env.example src/.env.hotupdater
# Edit src/.env.hotupdater with your auth and storage credentials
```

3. Apply the Hot Updater schema:
```bash
pnpm exec hot-updater db migrate src/db.ts --yes
```

The server does not apply migrations on startup.

4. Start development server:
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
GET /hot-updater/app-version/:platform/:version/:channel/:minBundleId/:bundleId
GET /hot-updater/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId
```

### List Bundles
```bash
GET /hot-updater/api/bundles?channel=production&platform=ios&limit=50
Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>
```

### Create Bundle
```bash
POST /hot-updater/api/bundles
Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>
Content-Type: application/json

{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "platform": "ios",
  "targetAppVersion": "1.0.0",
  "channel": "production",
  "enabled": true,
  "shouldForceUpdate": false,
  "fileHash": "abc123",
  "storageUri": "s3://bucket/bundles/bundle.zip",
  "message": "Initial release",
  "gitCommitHash": null,
  "fingerprintHash": null
}
```

### Delete Bundle
```bash
DELETE /hot-updater/api/bundles/:id
Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>
```

### List Channels
```bash
GET /hot-updater/api/bundles/channels
Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>
```

## Project Structure

```
hono-server/
├── src/
│   ├── index.ts      # Main server entry point
│   ├── db.ts         # Database setup (PGlite + Kysely + Hot Updater)
│   └── routes.ts     # API routes
├── data/             # PGlite database files (gitignored)
├── package.json
└── tsconfig.json
```

## Database

The server uses PGlite with file-based storage in `./data`.
The database schema is generated from Hot Updater's versioned schema and
migrated through the Hot Updater CLI.

## Storage Configuration

The example uses Cloudflare R2 through its S3-compatible endpoint. Configure
the `s3Storage` credentials with:

```env
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
R2_BUCKET_NAME=your-bucket-name
```

You can also use other storage providers by modifying `src/db.ts`.

## Production

Build and run in production:

```bash
pnpm build
set -a
. src/.env.hotupdater
set +a
node dist/src/index.js
```

The compiled entry resolves its dotenv path under `dist/src`, so production
must inject the environment externally as shown above. The checked-in
`pnpm start` command still points to `dist/index.js`; use the emitted entry
point above.
