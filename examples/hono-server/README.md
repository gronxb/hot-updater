# Hot Updater Server with Hono + PGlite

A production-ready Hot Updater server example using:
- **Hono** - Fast web framework
- **PGlite** - Lightweight PostgreSQL in Node.js (no server required)
- **Kysely** - Type-safe SQL query builder
- **FumaDB** - Database migration and ORM

## Features

- ✅ No PostgreSQL server needed (uses PGlite)
- ✅ File-based persistence
- ✅ Automatic schema migration
- ✅ RESTful API endpoints
- ✅ CORS enabled
- ✅ Request logging
- ✅ Graceful shutdown

## Setup

1. Install dependencies:
```bash
pnpm install
```

2. Configure environment variables (optional):
```bash
cp .env.example .env
# Edit .env with your AWS credentials
```

3. Start development server:
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
POST /api/update
Content-Type: application/json

{
  "platform": "ios",
  "appVersion": "1.0.0",
  "bundleId": "00000000-0000-0000-0000-000000000000",
  "_updateStrategy": "appVersion"
}
```

### List Bundles
```bash
GET /api/bundles?channel=production&platform=ios&limit=50
```

### Create Bundle
```bash
POST /api/bundles
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
DELETE /api/bundles/:id
```

### List Channels
```bash
GET /api/channels
```

## Project Structure

```
hono-server/
├── src/
│   ├── index.ts      # Main server entry point
│   ├── db.ts         # Database setup (PGlite + Kysely + FumaDB)
│   └── routes.ts     # API routes
├── data/             # PGlite database files (gitignored)
├── package.json
└── tsconfig.json
```

## Database

The server uses PGlite with file-based storage at `./data/hot-updater.db`. The database schema is automatically created and migrated using FumaDB.

On first run, the schema will be initialized automatically.

## Storage Configuration

By default, the example uses AWS S3 for bundle storage. Configure credentials via environment variables:

```env
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_BUCKET_NAME=your-bucket-name
```

You can also use other storage providers by modifying `src/db.ts`.

## Production

Build and run in production:

```bash
pnpm build
pnpm start
```
