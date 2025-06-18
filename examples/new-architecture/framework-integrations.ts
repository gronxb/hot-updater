// Examples of integrating HotUpdater with different frameworks
import { HotUpdater } from '@hot-updater/plugin-core';
import { supabaseDatabase, supabaseStorage } from '@hot-updater/adapters';

const hotUpdater = new HotUpdater({
  database: supabaseDatabase({
    url: process.env.SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!
  }),
  storage: supabaseStorage({
    url: process.env.SUPABASE_URL!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!
  })
});

// === Web Standards (Framework Independent) ===

// 1. Deno/Bun/Node.js with native fetch
async function handleRequest(request: Request): Promise<Response> {
  return hotUpdater.handler(request);
}

// === Framework-Specific Integrations ===

// 2. Fastify
import fastify from 'fastify';

const fastifyApp = fastify();
fastifyApp.all('/api/check-update/*', async (request, reply) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const webRequest = new Request(url, {
    method: request.method,
    headers: request.headers as Record<string, string>,
    body: request.method !== 'GET' ? request.body : undefined
  });
  
  const response = await hotUpdater.handler(webRequest);
  
  reply.status(response.status);
  response.headers.forEach((value, key) => {
    reply.header(key, value);
  });
  
  return response.body;
});

// 3. Koa
import Koa from 'koa';

const koaApp = new Koa();
koaApp.use(async (ctx) => {
  if (ctx.path.startsWith('/api/check-update')) {
    const url = new URL(ctx.url, `http://${ctx.headers.host}`);
    const request = new Request(url, {
      method: ctx.method,
      headers: ctx.headers as Record<string, string>,
      body: ctx.method !== 'GET' ? ctx.request.body : undefined
    });
    
    const response = await hotUpdater.handler(request);
    
    ctx.status = response.status;
    response.headers.forEach((value, key) => {
      ctx.set(key, value);
    });
    
    ctx.body = await response.text();
  }
});

// 4. SvelteKit
// src/routes/api/check-update/[...path]/+server.ts
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
  return hotUpdater.handler(request);
};

export const POST: RequestHandler = async ({ request }) => {
  return hotUpdater.handler(request);
};

// 5. Astro
// src/pages/api/check-update/[...path].ts
import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request }) => {
  return hotUpdater.handler(request);
};

export const POST: APIRoute = async ({ request }) => {
  return hotUpdater.handler(request);
};

// 6. Remix
// app/routes/api.check-update.$.tsx
import type { LoaderFunction, ActionFunction } from '@remix-run/node';

export const loader: LoaderFunction = async ({ request }) => {
  return hotUpdater.handler(request);
};

export const action: ActionFunction = async ({ request }) => {
  return hotUpdater.handler(request);
};

// 7. Nuxt.js
// server/api/check-update/[...path].ts
export default defineEventHandler(async (event) => {
  const request = new Request(getRequestURL(event), {
    method: getMethod(event),
    headers: getHeaders(event),
    body: getMethod(event) !== 'GET' ? await readBody(event) : undefined
  });
  
  return hotUpdater.handler(request);
});

// 8. Fresh (Deno)
// routes/api/check-update/[...path].ts
import { Handlers } from '$fresh/server.ts';

export const handler: Handlers = {
  async GET(req) {
    return hotUpdater.handler(req);
  },
  async POST(req) {
    return hotUpdater.handler(req);
  }
};