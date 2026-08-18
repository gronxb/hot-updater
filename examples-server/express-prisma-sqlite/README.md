# Hot Updater Server with Express, Prisma, and SQLite

This example runs the Hot Updater Web handler on Express 4 with Prisma and a
persistent SQLite database. It registers mock storage for fixtures and
Cloudflare R2 for real artifacts.

## Setup

1. Install the monorepo dependencies from the repository root:

   ```bash
   pnpm install
   ```

2. Create the environment file that `src/prisma.ts` loads:

   ```bash
   cd examples-server/express-prisma-sqlite
   cp .env.example src/.env.hotupdater
   ```

   Replace every placeholder. The example stores SQLite data at
   `./data/prisma.db`; `HOT_UPDATER_AUTH_TOKEN` protects management routes.

3. Merge the current Hot Updater models into `prisma/schema.prisma` and apply
   the schema:

   ```bash
   pnpm db:generate
   mkdir -p data
   touch data/prisma.db
   DATABASE_URL=file:../data/prisma.db pnpm db:push
   ```

4. Start the development server:

   ```bash
   pnpm dev
   ```

The server listens on `http://localhost:3002` by default.

## Safe Express mount

`toNodeHandler` converts Express requests and responses to the Web Standard
types used by Hot Updater. Because this example enables management and
analytics query routes, protect `/hot-updater/api/*` before mounting the
handler:

```typescript
import { toNodeHandler } from "@hot-updater/server/node";
import express from "express";

import { hotUpdater } from "./db";

const app = express();
const managementToken = process.env.HOT_UPDATER_AUTH_TOKEN;

app.use(express.json());
app.use("/hot-updater/api", (req, res, next) => {
  if (
    !managementToken ||
    req.get("Authorization") !== `Bearer ${managementToken}`
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
});
app.all("/hot-updater/*", toNodeHandler(hotUpdater));
```

A missing configured token, missing header, or mismatched token is rejected.
For example:

```bash
curl \
  -H "Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>" \
  http://localhost:3002/hot-updater/api/channels
```

The current NEXT source mounts v1 Bundle, Release, Release Catalog, Channel,
and database-commit management routes. The v0 branch mounts the legacy Bundle
surface instead, with channels at `/hot-updater/api/bundles/channels`; it does
not expose v1 Release or Release Catalog management. Use the example from the
branch matching the client version.

## Prisma workflow

`pnpm db:generate` reads `src/db.ts` and maintains the generated block between
the Hot Updater markers in `prisma/schema.prisma`. It preserves application
models, such as the example's `User` model, outside that block.

The generated block currently contains:

- `channels`
- `bundles`
- `bundle_patches`
- `releases`
- `release_catalogs`
- `bundle_events`
- `client_access_keys`
- `private_hot_updater_settings`

After generating the schema, regenerate the Prisma client and apply the
database change. Prisma resolves relative SQLite URLs from
`prisma/schema.prisma`, and its CLI does not load `src/.env.hotupdater`, so pass
the URL explicitly. On a fresh checkout, create the empty SQLite file before
the first push as shown in Setup.

```bash
DATABASE_URL=file:../data/prisma.db pnpm db:push
```

For production, generate the schema, then create and review migration files
before deployment:

```bash
pnpm db:generate
DATABASE_URL=file:../data/prisma.db \
  pnpm exec prisma migrate dev --name hot-updater-schema
```

## Build verification

Commit the generated schema and migration. You can verify the migration and
TypeScript build with:

```bash
DATABASE_URL=file:../data/prisma.db pnpm exec prisma migrate deploy
pnpm build
```

The current emitted ESM is not directly launchable by Node because its relative
imports omit file extensions. Use `pnpm dev` for this example until that build
issue is fixed. A deployed adaptation must inject `PORT`,
`HOT_UPDATER_AUTH_TOKEN`, and the R2 credentials through the deployment
environment or process manager instead of relying on the source-tree env file.

## Testing

The integration suite generates the Hot Updater schema, pushes it to an
isolated SQLite database, starts the server, and exercises the database API:

```bash
pnpm test
```

## Project structure

```text
express-prisma-sqlite/
├── src/
│   ├── .env.hotupdater             # Local environment file (gitignored)
│   ├── db.ts                       # Hot Updater configuration
│   ├── index.ts                    # Express entry point and auth middleware
│   ├── prisma.ts                   # Environment and Prisma client setup
│   └── handler.integration.spec.ts # Integration tests
├── prisma/
│   └── schema.prisma               # App schema plus generated models
├── data/                            # SQLite database files (gitignored)
├── .env.example
└── package.json
```
