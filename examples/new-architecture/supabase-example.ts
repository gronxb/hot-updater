// Example: Supabase + Supabase Storage (optimal combination)
import { HotUpdater } from '@hot-updater/plugin-core';
import { supabaseDatabase, supabaseStorage } from '@hot-updater/adapters';

// Core instance - framework independent
export const hotUpdater = new HotUpdater({
  database: supabaseDatabase({
    url: process.env.SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!
  }),
  storage: supabaseStorage({
    url: process.env.SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!
  })
});

// === Framework Integration Examples ===

// 1. Hono (current style)
import { Hono } from 'hono';

const app = new Hono();
app.all('/api/check-update/*', async (c) => {
  return hotUpdater.handler(c.req.raw);
});

// 2. Next.js App Router
// app/api/check-update/[...route]/route.ts
export async function GET(request: Request) {
  return hotUpdater.handler(request);
}

export async function POST(request: Request) {
  return hotUpdater.handler(request);
}

// 3. Cloudflare Workers
export default {
  async fetch(request: Request): Promise<Response> {
    return hotUpdater.handler(request);
  }
};

// 4. Express (with utility)
import express from 'express';

const expressApp = express();
const toNodeHandler = (handler: (req: Request) => Promise<Response>) => {
  return async (req: express.Request, res: express.Response) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method !== 'GET' ? req : undefined
    });
    
    const response = await handler(request);
    res.status(response.status);
    
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    
    const body = await response.text();
    res.send(body);
  };
};

expressApp.all('/api/check-update/*', toNodeHandler(hotUpdater.handler));

// 5. Elysia
import { Elysia } from 'elysia';

const elysiaApp = new Elysia()
  .all('/api/check-update/*', async ({ request }) => {
    const response = await hotUpdater.handler(request);
    return response;
  })
  .listen(3000);