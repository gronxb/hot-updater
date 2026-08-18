# Hot Updater Server with Hono + PGlite

This workspace example runs the v0 Hot Updater server contract with Hono,
PGlite, and Kysely. PGlite persists its PostgreSQL-compatible data in
`./data`; no separate PostgreSQL server is required.

## Setup

Install workspace dependencies from the repository root, then enter this
example:

```bash
pnpm install
cd examples-server/hono-kysely-pglite
```

Copy the documented server environment file to the path loaded by
`src/db.ts`:

```bash
cp .env.example src/.env.hotupdater
```

Set a strong `HOT_UPDATER_AUTH_TOKEN` and valid R2 credentials in that
file. Management requests fail closed when the token is unset or incorrect.

Apply the checked-in Hot Updater migrations before starting the server:

```bash
pnpm exec hot-updater db migrate src/db.ts --yes
pnpm dev
```

The server listens on `http://localhost:3000`. Startup does not apply
database migrations automatically.

## Routes

Health check:

```bash
curl http://localhost:3000/
```

App-version update check (public):

```bash
curl "http://localhost:3000/hot-updater/app-version/ios/1.0.0/production/0/0"
```

Fingerprint update check (public):

```bash
curl "http://localhost:3000/hot-updater/fingerprint/ios/YOUR_FINGERPRINT/production/0/0"
```

List bundles (Bearer token required):

Replace `<HOT_UPDATER_AUTH_TOKEN>` below with the value configured in
`src/.env.hotupdater`; that file is loaded by the server, not exported to your
shell.

```bash
curl \
  -H "Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>" \
  "http://localhost:3000/hot-updater/api/bundles?channel=production&platform=ios&limit=50"
```

Create a bundle. The v0 create route accepts an array of full bundle objects:

```bash
curl -X POST \
  -H "Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  http://localhost:3000/hot-updater/api/bundles \
  --data '[
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "platform": "ios",
      "targetAppVersion": "1.0.0",
      "channel": "production",
      "enabled": true,
      "shouldForceUpdate": false,
      "fileHash": "abc123",
      "storageUri": "r2://your-bucket-name/bundles/bundle.zip",
      "message": "Initial release",
      "gitCommitHash": null,
      "fingerprintHash": null,
      "metadata": {}
    }
  ]'
```

List channels:

```bash
curl \
  -H "Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>" \
  http://localhost:3000/hot-updater/api/bundles/channels
```

Delete a bundle:

```bash
curl -X DELETE \
  -H "Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>" \
  http://localhost:3000/hot-updater/api/bundles/550e8400-e29b-41d4-a716-446655440000
```

Omitting the header, using the wrong token, or leaving
`HOT_UPDATER_AUTH_TOKEN` unset returns `401` for management
routes. Public update-check routes remain reachable.

## Storage and Persistence

The example registers mock storage for local tests and Cloudflare R2 for real
artifacts with these variables:

```env
CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_BUCKET_NAME=your-bucket-name
```

PGlite stores database files in `./data`, relative to the example's
working directory.

## Production

```bash
pnpm exec hot-updater db migrate src/db.ts --yes
pnpm build
node dist/src/index.js
```

The compiled module does not load the source-tree `src/.env.hotupdater` file.
Supply `PORT`, the management token, and R2 credentials through the deployment
environment or process manager instead of copying secrets into `dist`.
