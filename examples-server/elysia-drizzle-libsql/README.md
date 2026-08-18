# Elysia + Drizzle + libSQL Example

This is a pnpm workspace example for a v0 Hot Updater server using Elysia,
Drizzle, and a local libSQL database.

## Setup

From the repository root, install workspace dependencies and enter the example:

```bash
pnpm install
cd examples-server/elysia-drizzle-libsql
```

Create `src/.env.hotupdater`. The server fails management requests
closed unless `HOT_UPDATER_AUTH_TOKEN` is set. The checked-in server also
registers mock storage for development and Cloudflare R2 for real artifacts:

```env title="src/.env.hotupdater"
PORT=3001
HOT_UPDATER_AUTH_TOKEN=replace-with-a-secret
CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_BUCKET_NAME=your-bucket-name
```

If you intentionally use mock storage only for local development, the R2
values can remain unset. Do not use mock storage for deployed bundles.

Generate the current Hot Updater schema and apply it to the local database:

```bash
pnpm db:generate
pnpm db:push
pnpm dev
```

The server listens on `http://localhost:3001`. Update-check routes under
`/hot-updater/app-version/*` and
`/hot-updater/fingerprint/*` are public. Management routes under
`/hot-updater/api/*` require
`Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>`.

## Build Verification

Generate the schema and verify that TypeScript emits JavaScript:

```bash
pnpm db:generate
pnpm db:push
pnpm build
```

The current emitted ESM is not a production launch artifact: its entry point
is under `dist/src`, while the package start script targets `dist/index.js`,
and emitted extensionless imports are not resolved by Node. Use `pnpm dev` for
this example until those build-path issues are fixed. A deployed adaptation
must also apply reviewed migrations and inject the port, management token, and
R2 credentials through its deployment environment.
