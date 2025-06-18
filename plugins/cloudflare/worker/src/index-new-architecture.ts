// New architecture example for Cloudflare Workers
import { HotUpdater } from "@hot-updater/plugin-core";
import { d1Database, r2Storage } from "@hot-updater/adapters";

type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

// Create HotUpdater instance using the new better-auth style API
function createHotUpdater(env: Env) {
  return new HotUpdater({
    database: d1Database({
      database: env.DB
    }),
    storage: r2Storage({
      bucket: env.BUCKET,
      jwtSecret: env.JWT_SECRET
    })
  });
}

// Simple Cloudflare Worker implementation
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hotUpdater = createHotUpdater(env);
    
    // Add CORS headers for development
    const response = await hotUpdater.handler(request);
    
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    // Add CORS headers to response
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      newHeaders.set(key, value);
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }
};

// This replaces the previous 180+ lines of manual route handling with just a few lines!
// The new architecture handles:
// - Route parsing (header-based and path-based)
// - Database queries (D1 SQL)
// - Storage URL generation (R2 + JWT)
// - Error handling
// - Response formatting
// - All the complex logic is now abstracted into reusable adapters