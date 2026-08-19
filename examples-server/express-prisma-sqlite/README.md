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
import { toNodeHandler } from "@hot-updater/server/node";
import { hotUpdater } from "./db";

const app = express();

// Mount middleware
app.use(express.json());

// Mount Hot Updater handler
app.all("/hot-updater/*", toNodeHandler(hotUpdater));
```

The `toNodeHandler` adapter automatically converts between Express's req/res and Web Standard Request/Response.

The checked-in server fails closed when `HOT_UPDATER_AUTH_TOKEN` is missing and
requires its Bearer token for `/hot-updater/api/*` management requests.

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Configure environment variables:

```bash
cp .env.example src/.env.hotupdater
# Edit src/.env.hotupdater with your database, auth, and storage credentials
```

3. Generate Prisma schema from Hot Updater:

```bash
pnpm db:generate
```

This merges or replaces the Hot Updater-managed block in
`prisma/schema.prisma` while preserving its generator, datasource, and app
models. Regenerate the Prisma client afterward:

```bash
DATABASE_URL="file:../data/prisma.db" pnpm exec prisma generate
```

4. Apply the schema to the database:

```bash
DATABASE_URL="file:../data/prisma.db" pnpm db:push
```

For production, use Prisma migrations:

```bash
DATABASE_URL="file:../data/prisma.db" npx prisma migrate dev    # Create migration
DATABASE_URL="file:../data/prisma.db" npx prisma migrate deploy # Apply migration
```

## Development

Start the development server:

```bash
pnpm dev
```

The server will run on `http://localhost:3002`.

## Build Verification

Verify the TypeScript build with the same explicit Prisma URL:

```bash
DATABASE_URL="file:../data/prisma.db" pnpm build
```

The checked-in production start target is currently non-runnable because the TypeScript build preserves
extensionless ESM imports. Use `pnpm dev` until the production build target is
corrected.

## Testing

Run integration tests:

```bash
pnpm test
```

## Database Management

### Prisma Workflow for Hot Updater

Prisma uses a different workflow compared to Drizzle or Kysely adapters. The process involves integrating generated models into your Prisma schema file:

The workspace pins the Prisma CLI and `@prisma/client` to `6.19.3`. Keep the
CLI, package, and generated client versions aligned when upgrading.

**Step 1: Generate Hot Updater Models**

```bash
pnpm db:generate
```

This command reads `src/db.ts` and updates only the managed block in
`prisma/schema.prisma`.

**Step 2: Generate Prisma Client**

```bash
DATABASE_URL="file:../data/prisma.db" npx prisma generate
```

**Step 3: Apply Schema to Database**

For development (quick sync without migration files):

```bash
DATABASE_URL="file:../data/prisma.db" pnpm db:push
```

For production (with migration history):

```bash
DATABASE_URL="file:../data/prisma.db" npx prisma migrate dev --name init
DATABASE_URL="file:../data/prisma.db" npx prisma migrate deploy
```

### Why This Workflow?

Unlike Drizzle or Kysely, Prisma requires:
1. **Schema merge**: Hot Updater manages a delimited block in `prisma/schema.prisma`
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
- Database migrations use Prisma's built-in migration system
- The server includes graceful shutdown handlers for SIGTERM/SIGINT
- Integration tests automatically run schema generation and database push before starting the server
