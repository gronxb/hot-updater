# @hot-updater/server

Framework-independent server library for Hot Updater, inspired by [Better-Auth](https://github.com/better-auth/better-auth)'s architecture.

## Architecture

This package provides a unified, framework-independent way to deploy Hot Updater across different platforms. Instead of maintaining separate implementations for each provider, you can now:

- **Mix & Match**: Use any database with any storage provider
- **Framework Independence**: Works with any framework supporting Web API standards
- **Massive Code Reduction**: 92-97% less code compared to provider-specific implementations
- **Type Safety**: Full TypeScript support with adapter validation

## Quick Start

### Supabase Edge Function (10 lines)

```typescript
import { HotUpdater, supabaseDatabase, supabaseStorage } from "@hot-updater/server";

const hotUpdater = new HotUpdater({
  database: supabaseDatabase({ 
    url: Deno.env.get("SUPABASE_URL")!, 
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! 
  }),
  storage: supabaseStorage({ 
    url: Deno.env.get("SUPABASE_URL")!, 
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! 
  })
});

Deno.serve((request: Request) => hotUpdater.handler(request));
```

### Cloudflare Worker (15 lines)

```typescript
import { HotUpdater, d1Database, r2Storage } from "@hot-updater/server";

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

### Express Server (12 lines)

```typescript
import express from 'express';
import { HotUpdater, supabaseDatabase, supabaseStorage } from '@hot-updater/server';

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

## Available Adapters

### Database Adapters

- `supabaseDatabase(config)` - Supabase PostgreSQL
- `d1Database(config)` - Cloudflare D1
- `firestoreDatabase(config)` - Firebase Firestore
- `dynamoDBDatabase(config)` - AWS DynamoDB

### Storage Adapters

- `supabaseStorage(config)` - Supabase Storage
- `r2Storage(config)` - Cloudflare R2
- `firebaseStorage(config)` - Firebase Storage
- `cloudfrontStorage(config)` - AWS CloudFront

## Mix & Match Examples

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

## Compatibility Validation

The system automatically validates adapter compatibility:

```typescript
// This throws a helpful error:
const invalid = new HotUpdater({
  database: d1Database({ /* config */ }),      // Requires: ['r2', 'cloudfront']  
  storage: supabaseStorage({ /* config */ })   // Name: 'supabase-storage' ❌
});
// Error: Database adapter 'd1' is not compatible with storage adapter 'supabase-storage'
```

## Framework Support

Works with any framework supporting Web API standards:

- **Server Frameworks**: Hono, Express, Fastify, Koa
- **Full-Stack Frameworks**: Next.js, SvelteKit, Remix, Astro, Nuxt
- **Edge Runtimes**: Cloudflare Workers, Deno, Bun
- **Cloud Functions**: Supabase Edge Functions, Firebase Functions, AWS Lambda
- **Pure Node.js**: HTTP servers

## API

### HotUpdater

```typescript
class HotUpdater {
  constructor(config: HotUpdaterConfig);
  async handler(request: Request): Promise<Response>;
  async getUpdateInfo(args: GetBundlesArgs): Promise<UpdateResponse | null>;
}
```

### Supported Endpoints

- `GET /ping` - Health check
- `GET /` - Header-based update check (legacy)
- `GET /app-version/:platform/:version/:channel/:minBundleId/:bundleId` - App version strategy
- `GET /fingerprint/:platform/:hash/:channel/:minBundleId/:bundleId` - Fingerprint strategy

### Headers (for legacy endpoint)

- `x-app-platform` - Platform (`ios` | `android`)
- `x-bundle-id` - Current bundle ID
- `x-app-version` - App version (app version strategy)
- `x-fingerprint-hash` - Fingerprint hash (fingerprint strategy)
- `x-min-bundle-id` - Minimum bundle ID (optional)
- `x-channel` - Update channel (optional, defaults to "production")

## Migration from Provider-Specific Implementations

### Before (332 lines - Supabase Edge Function)

```typescript
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

### After (10 lines)

```typescript
import { HotUpdater, supabaseDatabase, supabaseStorage } from "@hot-updater/server";

const hotUpdater = new HotUpdater({
  database: supabaseDatabase({ url: Deno.env.get("SUPABASE_URL")!, serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! }),
  storage: supabaseStorage({ url: Deno.env.get("SUPABASE_URL")!, serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! })
});

Deno.serve((request: Request) => hotUpdater.handler(request));
```

**97% code reduction!**

## Testing

The package includes comprehensive tests using the standard `setupGetUpdateInfoTestSuite` from `@hot-updater/core`:

```typescript
import { setupGetUpdateInfoTestSuite } from '@hot-updater/core/test-utils';
import { HotUpdater } from '@hot-updater/server';

setupGetUpdateInfoTestSuite({
  createHotUpdater: (bundles) => {
    const hotUpdater = new HotUpdater({
      database: mockDatabaseAdapter(bundles),
      storage: mockStorageAdapter()
    });
    return { getUpdateInfo: (args) => hotUpdater.getUpdateInfo(args) };
  }
});
```

## Community Extensibility

Adding new adapters is straightforward:

```typescript
export function planetscaleDatabase(config: PlanetScaleConfig): DatabaseAdapter {
  return {
    name: 'planetscale',
    async getUpdateInfo(args) { /* implementation */ },
    async getTargetAppVersions(platform, minBundleId) { /* implementation */ }
  };
}

export function digitalOceanSpacesStorage(config: DOSpacesConfig): StorageAdapter {
  return {
    name: 'do-spaces',
    supportedSchemas: ['https'],
    async getSignedUrl(storageUri, expiresIn) { /* implementation */ }
  };
}
```