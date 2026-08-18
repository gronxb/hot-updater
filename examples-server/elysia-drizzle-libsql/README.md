# Hot Updater Server with Elysia, Drizzle, and LibSQL

This example runs Hot Updater on Elysia's Node adapter with a persistent local
LibSQL database, a generated Drizzle schema, and Cloudflare R2 storage.

## Setup

1. Install dependencies from the monorepo root:

   ```bash
   pnpm install
   ```

2. Move to the example package:

   ```bash
   cd examples-server/elysia-drizzle-libsql
   ```

   Create `src/.env.hotupdater`, which is the file loaded by `src/drizzle.ts`,
   with the following values and replace every placeholder:

   ```env
   PORT=3001
   HOT_UPDATER_AUTH_TOKEN=replace-with-a-long-random-token
   CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
   R2_ACCESS_KEY_ID=your-r2-access-key-id
   R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
   R2_BUCKET_NAME=your-r2-bucket-name
   HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY=replace-with-a-long-random-signing-key
   ```

3. Generate the Hot Updater Drizzle schema and apply it to the local database:

   ```bash
   pnpm db:generate
   pnpm db:push
   ```

4. Start the development server:

   ```bash
   pnpm dev
   ```

The server listens on `http://localhost:3001` by default and stores the SQLite
database at `./data/hot-updater.db`.

## Authentication and API version

The server enables management features and rejects every request under
`/hot-updater/api/*` unless it includes the exact header
`Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>`. Update checks remain public.

The current NEXT source exposes v1 Bundle, Release, Release Catalog, Channel,
and database-commit management routes. The v0 branch exposes the legacy Bundle
surface instead, including `/hot-updater/api/bundles/channels`, and does not
expose v1 Release or Release Catalog management. Use the source and schema from
the branch matching the client version.

## Build verification

The package can type-check and emit JavaScript after the schema is prepared:

```bash
pnpm db:generate
pnpm db:push
pnpm build
```

The current emitted ESM is not a production launch artifact: its entry point
is under `dist/src`, while the package start script targets `dist/index.js`,
and emitted extensionless imports are not resolved by Node. Use `pnpm dev` for
this example until those build-path issues are fixed. A deployed adaptation
must also replace `db:push` with a reviewed migration and inject the port,
management token, and R2 credentials through its deployment environment.
