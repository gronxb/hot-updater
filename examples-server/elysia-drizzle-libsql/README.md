# elysia-server

# Setup

Follow these steps to run [Elysia.js](https://elysiajs.com) under [Node.js](https://nodejs.org):

1. Install dependencies
   ```bash
   # From the repository root
   pnpm install
   cd examples-server/elysia-drizzle-libsql
   ```
2. Create `src/.env.hotupdater`:
   ```bash
   HOT_UPDATER_AUTH_TOKEN=replace-with-a-secret
   R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
   R2_ACCESS_KEY_ID=your-access-key-id
   R2_SECRET_ACCESS_KEY=your-secret-access-key
   R2_BUCKET_NAME=your-bucket-name
   ```
3. Generate and apply the schema:
   ```bash
   pnpm db:generate
   pnpm db:push
   ```
4. Start the development server:
   ```bash
   pnpm dev
   ```

Update checks are served below `/hot-updater`; management routes below
`/hot-updater/api/*` require `Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>`.
The checked-in `pnpm start` target does not match the current TypeScript output
path, so use `pnpm dev` until that build target is corrected.
