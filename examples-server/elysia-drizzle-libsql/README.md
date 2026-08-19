# elysia-server

# Setup

Follow these steps to run [Elysia.js](https://elysiajs.com) under [Node.js](https://nodejs.org):

1. Install the workspace dependencies and enter this package.

   ```bash
   pnpm install
   cd examples-server/elysia-drizzle-libsql
   ```

2. Create `src/.env.hotupdater`, the file loaded by `src/drizzle.ts`.

   ```env
   PORT=3001
   HOT_UPDATER_AUTH_TOKEN=replace-with-a-long-random-token
   R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
   R2_ACCESS_KEY_ID=your-r2-access-key-id
   R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
   R2_BUCKET_NAME=your-r2-bucket-name
   HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY=replace-with-a-long-random-signing-key
   ```

3. Generate the Drizzle schema and apply it to the local database.

   ```bash
   pnpm db:generate
   pnpm db:push
   ```

4. Start the development server.

   ```bash
   pnpm dev
   ```

`pnpm build` verifies that the package emits JavaScript, but the current output
is not directly launchable: the entry is under `dist/src`, the `start` script
targets `dist/index.js`, and emitted extensionless imports are not resolved by
Node.js. Use `pnpm dev` until those build-path issues are fixed. A deployed
adaptation must inject its port, authentication token, signing key, and R2
credentials through the deployment environment.
