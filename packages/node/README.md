# @hot-updater/node

Node.js runtime package for hot-updater self-hosted solutions. This package provides a framework-agnostic Web API-based handler that can be integrated with any Node.js runtime or framework.

## Features

- 🌐 **Web API Standard**: Uses standard `Request`/`Response` interfaces
- 🔧 **Framework Agnostic**: Works with any Node.js runtime or framework
- 🚀 **Lightweight**: No heavy dependencies
- 🔌 **Plugin-based**: Easy integration with database and storage providers
- 🎯 **Better-Auth Style API**: Simple and consistent API pattern

## Installation

```bash
npm install @hot-updater/node @hot-updater/supabase
```

## Quick Start (Better-Auth Style)

### Supabase + Express.js

```typescript
import express from "express";
import { HotUpdater, toNodeHandler } from "@hot-updater/node";
import { supabaseNodeDatabase, supabaseNodeStorage } from "@hot-updater/supabase";

const app = express();

const hotUpdater = new HotUpdater({
  database: supabaseNodeDatabase({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  }),
  storage: [supabaseNodeStorage({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  })]
});

// Simple one-liner integration!
app.all("/api/update/*", toNodeHandler(hotUpdater));

app.listen(3000);
```

### Cloudflare Workers + Hono

```typescript
import { Hono } from 'hono';
import { HotUpdater } from '@hot-updater/node';
import { d1NodeDatabase, r2NodeStorage } from '@hot-updater/cloudflare';

const app = new Hono();

const hotUpdater = new HotUpdater({
  database: d1NodeDatabase({ database: env.DATABASE }),
  storage: [r2NodeStorage({ bucket: env.BUCKET, jwtSecret: env.JWT_SECRET })]
});

// Direct handler usage (like better-auth)
app.on(['GET'], '/update/*', (c) => {
  return hotUpdater.handler(c.req.raw);
});

export default app;
```

## Framework Integrations

### Hono

```typescript
import { Hono } from "hono";
import { HotUpdater } from "@hot-updater/node";
import { supabaseNodeDatabase, supabaseNodeStorage } from "@hot-updater/supabase";

const app = new Hono();

const hotUpdater = new HotUpdater({
  database: supabaseNodeDatabase({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  }),
  storage: [supabaseNodeStorage({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  })]
});

app.get("/update", (c) => {
  return hotUpdater.handler(c.req.raw);
});

export default app;
```

### Express.js

```typescript
import express from "express";
import { HotUpdater, toNodeHandler } from "@hot-updater/node";
import { supabaseNodeDatabase, supabaseNodeStorage } from "@hot-updater/supabase";

const app = express();

const hotUpdater = new HotUpdater({
  database: supabaseNodeDatabase({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  }),
  storage: [supabaseNodeStorage({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  })]
});

app.get("/update", toNodeHandler(hotUpdater));

app.listen(3000);
```

### Next.js API Routes

```typescript
// app/api/update/route.ts
import { HotUpdater } from "@hot-updater/node";
import { supabaseNodeDatabase, supabaseNodeStorage } from "@hot-updater/supabase";

const hotUpdater = new HotUpdater({
  database: supabaseNodeDatabase({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  }),
  storage: [supabaseNodeStorage({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  })]
});

export const GET = async (request: Request) => {
  return hotUpdater.handler(request);
};
```

### Cloudflare Workers

```typescript
import { HotUpdater } from "@hot-updater/node";
import { d1NodeDatabase, r2NodeStorage } from "@hot-updater/cloudflare";

const hotUpdater = new HotUpdater({
  database: d1NodeDatabase({ database: env.DATABASE }),
  storage: [r2NodeStorage({ bucket: env.BUCKET, jwtSecret: env.JWT_SECRET })]
});

export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === "/update" && request.method === "GET") {
      return hotUpdater.handler(request);
    }
    
    return new Response("Not Found", { status: 404 });
  }
};
```

## API

### `createHandler(config)`

Creates a Web API handler function.

**Parameters:**
- `config.database`: Database adapter instance
- `config.storage`: Array of storage adapter instances

**Returns:** `(request: Request) => Promise<Response>`

### `createRouteMatcher(basePath?)`

Creates a route matcher function for the update endpoint.

**Parameters:**
- `basePath`: Base path for the update endpoint (default: `/update`)

**Returns:** `(request: Request) => boolean`

## Better-Auth Style API

### Clean HotUpdater Initialization

```typescript
// Supabase
import { HotUpdater } from "@hot-updater/node";
import { supabaseNodeDatabase, supabaseNodeStorage } from "@hot-updater/supabase";

const hotUpdater = new HotUpdater({
  database: supabaseNodeDatabase({ url: "...", serviceRoleKey: "..." }),
  storage: [supabaseNodeStorage({ url: "...", serviceRoleKey: "..." })]
});

// Cloudflare  
import { d1NodeDatabase, r2NodeStorage } from "@hot-updater/cloudflare";

const hotUpdater = new HotUpdater({
  database: d1NodeDatabase({ database: env.DATABASE }),
  storage: [r2NodeStorage({ bucket: env.BUCKET, jwtSecret: env.JWT_SECRET })]
});
```

### Usage Patterns

```typescript
// Express.js/Node.js
app.all("/api/update/*", toNodeHandler(hotUpdater));

// Hono/Cloudflare Workers
app.on(['GET'], '/update/*', (c) => {
  return hotUpdater.handler(c.req.raw);
});

// Next.js API Routes
export const GET = async (request: Request) => {
  return hotUpdater.handler(request);
};

// Any Web API compatible runtime
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/update")) {
      return hotUpdater.handler(request);
    }
    return new Response("Not Found", { status: 404 });
  }
};
```

## Provider Integrations

Each provider plugin exports adapter functions that work with the `HotUpdater` class:

- **Node Adapters**: `{provider}NodeDatabase()`, `{provider}NodeStorage()`
- **Legacy helpers**: `create{Provider}Handler`, `create{Provider}HonoApp`, etc. (for backward compatibility)

**Available Providers:**
- **Supabase**: `supabaseNodeDatabase`, `supabaseNodeStorage`
- **Cloudflare**: `d1NodeDatabase`, `r2NodeStorage` 
- **Firebase**: `firestoreNodeDatabase`, `firebaseNodeStorage` (coming soon)
- **AWS**: `s3NodeDatabase`, `s3NodeStorage` (coming soon)

**Mix and Match:**
```typescript
// Use D1 database with Supabase storage
const hotUpdater = new HotUpdater({
  database: d1NodeDatabase({ database: env.DATABASE }),
  storage: [supabaseNodeStorage({ url: "...", serviceRoleKey: "..." })]
});
```