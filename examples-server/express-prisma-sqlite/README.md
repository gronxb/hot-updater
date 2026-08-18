# Express + Prisma + SQLite Example

This workspace example runs the v0 Hot Updater server contract with Express,
Prisma, and SQLite. Management routes are protected with Bearer authentication;
update-check routes remain public.

## Setup

Install workspace dependencies from the repository root, then enter the
example:

```bash
pnpm install
cd examples-server/express-prisma-sqlite
```

Copy the environment template to the path loaded by `src/prisma.ts`:

```bash
cp .env.example src/.env.hotupdater
```

Set a strong `HOT_UPDATER_AUTH_TOKEN` and valid Cloudflare R2 credentials.
Mock storage is registered for local tests only.

## Prisma Workflow

Generate and merge the current Hot Updater models directly into
`prisma/schema.prisma`:

```bash
pnpm db:generate
```

The generator preserves application models and replaces the managed
Hot Updater block, including `bundles` and
`bundle_patches`. There is no separate schema excerpt to copy.

Generate Prisma Client and apply the merged schema:

```bash
pnpm exec prisma generate
DATABASE_URL=file:../data/prisma.db pnpm db:push
```

For production, create and deploy a reviewed Prisma migration instead of using
`db push`.

## Secured Express Mount

The server parses JSON before the Hot Updater handler, rejects missing or
incorrect management credentials, and mounts without an unnamed wildcard:

```typescript
import { toNodeHandler } from "@hot-updater/server/node";
import express from "express";

import { hotUpdater } from "./db";

const managementToken = process.env.HOT_UPDATER_AUTH_TOKEN;
if (!managementToken) {
  throw new Error("HOT_UPDATER_AUTH_TOKEN is required");
}

const app = express();
app.use(express.json());

app.use("/hot-updater/api", (req, res, next) => {
  if (req.get("Authorization") !== `Bearer ${managementToken}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
});

app.use("/hot-updater", toNodeHandler(hotUpdater));
```

The checked-in implementation uses the same fail-closed token check. Supply
`Authorization: Bearer <HOT_UPDATER_AUTH_TOKEN>` for
`/hot-updater/api/*`. Requests without the header, with a wrong token,
or with an unset server token are rejected.

## Development

```bash
pnpm dev
```

The server listens on `http://localhost:3002`.

## Build Verification

```bash
pnpm build
```

The current emitted ESM is not directly launchable by Node because its relative
imports omit file extensions. Use `pnpm dev` for this example until that build
issue is fixed. A deployed adaptation must run reviewed schema migrations and
inject `PORT`, `HOT_UPDATER_AUTH_TOKEN`, and the R2 credentials through its
deployment environment instead of relying on the source-tree env file.

## Tests

```bash
pnpm test
```
