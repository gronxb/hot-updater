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

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Configure environment variables:

```bash
cp .env.example .env
# Edit .env with your database and storage credentials
```

3. Generate Prisma schema from Hot Updater:

```bash
pnpm db:generate
```

This merges the fixed Hot Updater models directly into
`prisma/schema.prisma` while preserving application models.

4. Apply the schema to the database:

```bash
pnpm db:push
```

For production, use Prisma migrations:

```bash
npx prisma migrate dev    # Create migration
npx prisma migrate deploy # Apply migration
```

## Development

Start the development server:

```bash
pnpm dev
```

The server will run on `http://localhost:3002`.

## Production

Build and run:

```bash
pnpm build
pnpm start
```

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
2. Merges the fixed `bundles`, `bundle_patches`, `bundle_events`, and
   `private_hot_updater_settings` models into `prisma/schema.prisma`
3. Preserves application models outside the generated block

**Step 2: Generate Prisma Client**

```bash
npx prisma generate
```

**Step 3: Apply Schema to Database**

For development (quick sync without migration files):

```bash
pnpm db:push
```

For production (with migration history):

```bash
npx prisma migrate dev --name init
npx prisma migrate deploy
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
- Database migrations use Prisma's built-in migration system
- The server includes graceful shutdown handlers for SIGTERM/SIGINT
- Integration tests automatically run schema generation and database push before starting the server
