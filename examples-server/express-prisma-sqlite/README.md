# Express + Prisma Example

This example demonstrates how to use Hot Updater with Express and Prisma.

## Features

- **Framework**: Express.js 4.x
- **Database**: SQLite with Prisma ORM
- **Adapter**: Prisma adapter (`@hot-updater/server/adapters/prisma`)
- **Node.js Adapter**: `toNodeHandler` for seamless Express integration
- **Storage**: Mock storage + AWS S3 / Cloudflare R2

## Quick Start

Use Node.js 20.19 or later for native environment-file loading.

```typescript
import express from "express";
import cors from "cors";
import { toNodeHandler } from "@hot-updater/server";
import { hotUpdater } from "./db";

const app = express();
const adminToken = process.env.HOT_UPDATER_ADMIN_TOKEN;
if (!adminToken) throw new Error("HOT_UPDATER_ADMIN_TOKEN is required.");

app.use(
  "/hot-updater/admin",
  (req, res, next) => {
    if (req.get("Authorization") !== `Bearer ${adminToken}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  },
  express.json({ limit: "1mb" }),
  toNodeHandler(hotUpdater.handlers.admin),
);
app.use(
  "/hot-updater",
  cors(),
  express.json({ limit: "1mb" }),
  toNodeHandler(hotUpdater.handlers.client),
);
```

The `toNodeHandler` adapter automatically converts between Express's req/res
and Web Standard Request/Response. Send
`Authorization: Bearer <HOT_UPDATER_ADMIN_TOKEN>` to admin routes under
`/hot-updater/admin/*`; missing or mismatched credentials are rejected.

## Setup

1. Install and build the workspace dependencies from the repository root:

```bash
pnpm install
pnpm -w build
cd examples-server/express-prisma-sqlite
```

2. Configure environment variables:

```bash
cp .env.example src/.env.hotupdater
# Edit src/.env.hotupdater with your authentication and storage credentials
```

3. Generate the client from the checked-in schema before loading `src/db.ts`,
   then generate the Hot Updater models:

```bash
mkdir -p data
DATABASE_URL=file:../data/prisma.db pnpm exec prisma generate
pnpm db:generate
```

The first command that loads `src/db.ts` needs the client in
`src/generated/prisma`. Hot Updater then merges its managed models directly
into `prisma/schema.prisma` while preserving application models.

4. Apply the schema to the database:

```bash
DATABASE_URL=file:../data/prisma.db pnpm db:push
pnpm exec hot-updater db migrate src/db.ts --yes
```

`db:push` also regenerates the Prisma client. The final Hot Updater migration
initializes the core and Insights schema settings checked by the server.
For a workflow with committed Prisma migrations, see
[Prisma Workflow for Hot Updater](#prisma-workflow-for-hot-updater).

## Development

Start the development server:

```bash
pnpm dev
```

The server will run on `http://localhost:3002`.

## Production

Build verification:

```bash
pnpm build
```

The emitted ESM is not directly launchable by Node.js because its relative
imports omit file extensions. Use `pnpm dev` until that build issue is fixed.
A deployed adaptation must inject `PORT`, `HOT_UPDATER_ADMIN_TOKEN`, the signing
key, and R2 credentials through its deployment environment instead of relying
on the source-tree env file.

## Testing

Run integration tests:

```bash
pnpm test
```

## Database Management

### Prisma Workflow for Hot Updater

Prisma uses a different workflow compared to Drizzle or Kysely adapters. The
Hot Updater CLI manages a generated block inside the existing Prisma schema.

**Step 1: Bootstrap the Prisma Client and Generate Hot Updater Models**

On a fresh checkout, generate the client from the checked-in schema before
`db:generate` imports `src/db.ts`:

```bash
mkdir -p data
DATABASE_URL=file:../data/prisma.db pnpm exec prisma generate
pnpm db:generate
```

`pnpm db:generate`:

1. Reads your Hot Updater configuration from `src/db.ts`
2. Merges the core and configured plugin models into `prisma/schema.prisma`
3. Preserves application models outside the generated block

**Step 2: Generate Prisma Client**

```bash
DATABASE_URL=file:../data/prisma.db pnpm exec prisma generate
```

**Step 3: Apply Schema to Database**

For development (quick sync without migration files):

```bash
DATABASE_URL=file:../data/prisma.db pnpm db:push
```

For a workflow with migration history, create migrations against the local
development database and commit `prisma/migrations`:

```bash
DATABASE_URL=file:../data/prisma.db pnpm exec prisma migrate dev --name init
```

Apply those committed migrations to the deployment database with
`pnpm exec prisma migrate deploy`. Set `DATABASE_URL` to that database's URL.

**Step 4: Initialize Hot Updater Schema Settings**

After `db:push` or `prisma migrate deploy`, run:

```bash
pnpm exec hot-updater db migrate src/db.ts --yes
```

This writes the core and Insights schema settings that the server checks before
serving database requests. This example's `src/prisma.ts` selects
`data/prisma.db` by default; for another SQLite file, set `TEST_DB_PATH` to its
absolute path for both this command and the server, and point Prisma's
`DATABASE_URL` at the same file.

### Why This Workflow?

Unlike Drizzle (which generates complete TypeScript schema files) or Kysely (which uses SQL migrations), Prisma requires:

1. **Schema merge**: `db generate` maintains the generated models in `prisma/schema.prisma`
2. **Client generation**: Prisma Client must be generated from the schema
3. **Database sync**: Use `db push` (dev) or `migrate deploy` to apply table changes
4. **Settings migration**: Use `hot-updater db migrate` to initialize schema settings

## Project Structure

```
express-server/
├── src/
│   ├── index.ts              # Express server entry point
│   ├── db.ts                 # Hot Updater configuration
│   ├── prisma.ts             # Prisma client initialization
│   ├── routes.ts             # Route handlers
│   └── handler.integration.spec.ts  # Integration tests
├── prisma/
│   └── schema.prisma         # Base Prisma schema
├── data/                     # SQLite database (gitignored)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Notes

- The Prisma adapter connects Hot Updater's storage engine to Prisma through
  the shared SQL adapter and generates Prisma schema artifacts
- Schema generation is handled by Hot Updater CLI (`db generate`)
- Prisma applies table changes; Hot Updater initializes its schema settings
- The server includes graceful shutdown handlers for SIGTERM/SIGINT
- Integration tests regenerate the schema and client, push the database schema,
  and initialize Hot Updater settings before starting the server
