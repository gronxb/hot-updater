# Express + Prisma Example

This example demonstrates how to use Hot Updater with Express and Prisma.

## Features

- **Framework**: Express.js 4.x
- **Database**: SQLite with Prisma ORM
- **Adapter**: Prisma adapter (`@hot-updater/server/adapters/prisma`)
- **Node.js Adapter**: `toNodeHandler` for seamless Express integration
- **Storage**: Mock storage + AWS S3 / Cloudflare R2

## Quick Start

```typescript
import express from "express";
import cors from "cors";
import { toNodeHandler } from "@hot-updater/server/node";
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

1. Install dependencies:

```bash
pnpm install
cd examples-server/express-prisma-sqlite
```

2. Configure environment variables:

```bash
cp .env.example src/.env.hotupdater
# Edit src/.env.hotupdater with your authentication and storage credentials
```

3. Generate Prisma schema from Hot Updater:

```bash
pnpm db:generate
```

This merges the fixed Hot Updater models directly into
`prisma/schema.prisma` while preserving application models.

4. Apply the schema to the database:

```bash
mkdir -p data
touch data/prisma.db
DATABASE_URL=file:../data/prisma.db pnpm db:push
TEST_DB_PATH=$(pwd)/data/prisma.db npx hot-updater db migrate src/db.ts --yes
```

For production, use Prisma migrations:

```bash
DATABASE_URL=file:../data/prisma.db npx prisma migrate dev --name init
DATABASE_URL=file:../data/prisma.db npx prisma migrate deploy
TEST_DB_PATH=$(pwd)/data/prisma.db npx hot-updater db migrate src/db.ts --yes
```

Run the Hot Updater migration after every Prisma schema deployment and before
starting the server. Prisma owns the generated application tables; Hot Updater
owns the provider-specific Insights tables, indexes, and source state that
Prisma schema syntax cannot represent. Keep
`HOT_UPDATER_INSIGHTS_DATABASE_NAMESPACE` as one stable lowercase UUID for the
lifetime of the database. For an existing database, stop and drain every Hot
Updater event writer before provisioning and start only the new server version
after it completes.

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

**Step 1: Generate Hot Updater Models**

```bash
pnpm db:generate
```

This command:

1. Reads your Hot Updater configuration from `src/db.ts`
2. Merges the fixed `channels`, `bundles`, `bundle_patches`, `releases`,
   `release_catalogs`, `bundle_events`, `api_keys`, and
   `private_hot_updater_settings` models into `prisma/schema.prisma`
3. Preserves application models outside the generated block

**Step 2: Generate Prisma Client**

```bash
npx prisma generate
```

**Step 3: Apply Schema to Database**

For development (quick sync without migration files):

```bash
DATABASE_URL=file:../data/prisma.db pnpm db:push
```

For production (with migration history):

```bash
DATABASE_URL=file:../data/prisma.db npx prisma migrate dev --name init
DATABASE_URL=file:../data/prisma.db npx prisma migrate deploy
```

### Why This Workflow?

Unlike Drizzle (which generates complete TypeScript schema files) or Kysely (which uses SQL migrations), Prisma requires:

1. **Schema merge**: `db generate` maintains the generated models in `prisma/schema.prisma`
2. **Client generation**: Prisma Client must be generated from the schema
3. **Database sync**: Use `db push` (dev) or `migrate` (production) to apply changes

This is the standard Prisma workflow and applies to other tools using Prisma (like better-auth).

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

- The Prisma adapter uses Hot Updater's DatabasePlugin contract with generated
  Prisma schema artifacts
- Schema generation is handled by Hot Updater CLI (`db generate`)
- Prisma migrations own the generated core tables; `hot-updater db migrate`
  owns the separate Insights layout
- The server includes graceful shutdown handlers for SIGTERM/SIGINT
- Integration tests automatically run schema generation, database push, and
  Insights provisioning before starting the server
