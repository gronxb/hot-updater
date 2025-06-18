# Hot-Updater Architecture Refactoring: Before vs After

## Overview
This document shows the transformation from provider-specific implementations to a unified, better-auth style architecture.

## Before: Provider-Specific Implementation

### Cloudflare Worker (183 lines)
```typescript
// plugins/cloudflare/worker/src/index.ts
import { type GetBundlesArgs, NIL_UUID } from "@hot-updater/core";
import { verifyJwtSignedUrl, withJwtSignedUrl } from "@hot-updater/js";
import { Hono } from "hono";
import { getUpdateInfo } from "./getUpdateInfo";

type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

const app = new Hono<{ Bindings: Env }>();

const handleUpdateRequest = async (
  db: D1Database,
  updateConfig: GetBundlesArgs,
  reqUrl: string,
  jwtSecret: string,
) => {
  // ... 30+ lines of logic
};

// 3 different route handlers, each 30-50 lines
app.get("/api/check-update", async (c) => { /* 50 lines */ });
app.get("/api/check-update/app-version/:platform/:app-version/:channel/:minBundleId/:bundleId", async (c) => { /* 40 lines */ });
app.get("/api/check-update/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId", async (c) => { /* 40 lines */ });
app.get("*", async (c) => { /* 20 lines for signed URL handling */ });

export default app;
```

### Supabase Edge Function (332 lines)
```typescript
// plugins/supabase/supabase/edge-functions/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import semver from "npm:semver@7.7.1";
import { Hono } from "jsr:@hono/hono";
import { type SupabaseClient, createClient } from "jsr:@supabase/supabase-js@2.49.4";

// 100+ lines of strategy functions
const appVersionStrategy = async (supabase, config) => { /* 40 lines */ };
const fingerprintHashStrategy = async (supabase, config) => { /* 25 lines */ };
const handleUpdateRequest = async (supabase, updateConfig) => { /* 60 lines */ };

// 3 route handlers, similar complexity
const app = new Hono().basePath(`/${functionName}`);
app.get("/ping", (c) => c.text("pong"));
app.get("/", async (c) => { /* 60 lines */ });
app.get("/app-version/:platform/:app-version/:channel/:minBundleId/:bundleId", async (c) => { /* 45 lines */ });
app.get("/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId", async (c) => { /* 45 lines */ });

Deno.serve(app.fetch);
```

**Problems:**
- ❌ **Code Duplication**: Same route logic repeated across providers
- ❌ **Provider Lock-in**: Can't mix database and storage from different providers  
- ❌ **Framework Coupling**: Tied to Hono framework
- ❌ **Maintenance Burden**: Bug fixes need to be applied to each provider
- ❌ **Testing Complexity**: Each provider needs separate test suites

## After: Unified Better-Auth Style Architecture

### Core Framework-Independent Design
```typescript
// plugins/plugin-core/src/hot-updater.ts
export class HotUpdater {
  constructor(config: HotUpdaterConfig) {
    // Validate adapter compatibility
    const compatibility = validateAdapterCompatibility(config.database, config.storage);
    if (!compatibility.compatible) {
      throw new Error(`Adapter compatibility error: ${compatibility.errors.join(', ')}`);
    }
    this.config = config;
  }

  async handler(request: Request): Promise<Response> {
    // Universal Web API Request/Response handling
    // Works with any framework that supports Web Standards
  }
}
```

### Cloudflare Worker (15 lines)
```typescript
// New implementation
import { HotUpdater } from "@hot-updater/plugin-core";
import { d1Database, r2Storage } from "@hot-updater/adapters";

type Env = { DB: D1Database; BUCKET: R2Bucket; JWT_SECRET: string; };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hotUpdater = new HotUpdater({
      database: d1Database({ database: env.DB }),
      storage: r2Storage({ bucket: env.BUCKET, jwtSecret: env.JWT_SECRET })
    });
    return hotUpdater.handler(request);
  }
};
```

### Supabase Edge Function (10 lines)
```typescript
// New implementation  
import { HotUpdater } from "@hot-updater/plugin-core";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/adapters";

const hotUpdater = new HotUpdater({
  database: supabaseDatabase({ url: Deno.env.get("SUPABASE_URL")!, serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! }),
  storage: supabaseStorage({ url: Deno.env.get("SUPABASE_URL")!, serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! })
});

Deno.serve((request: Request) => hotUpdater.handler(request));
```

### Express Server (12 lines)
```typescript
import express from 'express';
import { HotUpdater } from '@hot-updater/plugin-core';
import { supabaseDatabase, supabaseStorage } from '@hot-updater/adapters';

const hotUpdater = new HotUpdater({
  database: supabaseDatabase({ /* config */ }),
  storage: supabaseStorage({ /* config */ })
});

const app = express();
app.all('/api/check-update/*', toNodeHandler(hotUpdater.handler));
app.listen(3000);
```

### Next.js App Router (6 lines)
```typescript
// app/api/check-update/[...route]/route.ts
import { hotUpdater } from '@/lib/hot-updater';

export async function GET(request: Request) { return hotUpdater.handler(request); }
export async function POST(request: Request) { return hotUpdater.handler(request); }
```

## Key Benefits

### ✅ **Massive Code Reduction**
- **Cloudflare**: 183 → 15 lines (**92% reduction**)
- **Supabase**: 332 → 10 lines (**97% reduction**)
- **All Providers**: ~1000+ lines → ~50 lines total

### ✅ **Framework Independence**
Works with any framework supporting Web API standards:
- Hono, Express, Fastify, Koa
- Next.js, SvelteKit, Remix, Astro, Nuxt
- Cloudflare Workers, Deno, Bun
- Pure Node.js/HTTP servers

### ✅ **Mix & Match Providers**
```typescript
// Use Supabase DB with CloudFront CDN
const mixedConfig = new HotUpdater({
  database: supabaseDatabase({ /* config */ }),
  storage: cloudfrontStorage({ /* config */ })
});

// Use Firestore with any storage
const flexibleConfig = new HotUpdater({
  database: firestoreDatabase({ /* config */ }),  // No dependencies
  storage: r2Storage({ /* config */ })             // Works with any
});
```

### ✅ **Automatic Compatibility Validation**
```typescript
// This throws a helpful error:
const invalid = new HotUpdater({
  database: d1Database({ /* config */ }),      // Requires: ['r2', 'cloudfront']  
  storage: supabaseStorage({ /* config */ })   // Name: 'supabase-storage' ❌
});
// Error: Database adapter 'd1' is not compatible with storage adapter 'supabase-storage'
```

### ✅ **Single Source of Truth**
- Route logic: `HotUpdater.handler()`
- Database queries: `DatabaseAdapter.getUpdateInfo()`
- Storage URLs: `StorageAdapter.getSignedUrl()`
- Compatibility: `validateAdapterCompatibility()`

### ✅ **Easy Testing**
```typescript
// Test all combinations with mock adapters
const testConfig = new HotUpdater({
  database: mockDatabase(),
  storage: mockStorage()
});
```

### ✅ **Community Extensibility**
```typescript
// Community can add new adapters easily
export function planetscaleDatabase(config) { /* implementation */ }
export function digitalOceanSpacesStorage(config) { /* implementation */ }

const communityConfig = new HotUpdater({
  database: planetscaleDatabase({ /* config */ }),
  storage: digitalOceanSpacesStorage({ /* config */ })
});
```

## Migration Path

1. **Phase 1**: New architecture alongside existing (✅ Complete)
2. **Phase 2**: Gradual migration of existing plugins  
3. **Phase 3**: Deprecate old provider-specific implementations
4. **Phase 4**: Remove old code once migration is complete

## Inspiration: Better-Auth

This architecture follows the same pattern as [Better-Auth](https://github.com/better-auth/better-auth):

```typescript
// Better-Auth style
const auth = betterAuth({ database: new Pool() })
app.mount(auth.handler)  // Elysia
app.all("/api/auth/*", toNodeHandler(auth))  // Express

// Hot-Updater style  
const hotUpdater = new HotUpdater({ database: d1Database(), storage: r2Storage() })
app.mount(hotUpdater.handler)  // Elysia
app.all("/api/check-update/*", toNodeHandler(hotUpdater))  // Express
```

Both provide:
- Framework-independent core
- Adapter pattern for different providers
- Single handler function for all routes
- Type-safe configuration
- Extensible architecture