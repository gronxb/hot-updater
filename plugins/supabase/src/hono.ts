import { Hono } from "hono";
import { createHandler } from "@hot-updater/node";
import { supabaseNodeDatabase, supabaseNodeStorage } from "./adapters";
import type { SupabaseNodeDatabaseConfig, SupabaseNodeStorageConfig } from "./adapters";

export interface SupabaseHonoConfig {
  database: SupabaseNodeDatabaseConfig;
  storage: SupabaseNodeStorageConfig;
  basePath?: string;
}

export function createSupabaseHonoApp(config: SupabaseHonoConfig): Hono {
  const database = supabaseNodeDatabase(config.database);
  const storage = supabaseNodeStorage(config.storage);

  const handler = createHandler({
    database,
    storage: [storage]
  });

  const app = new Hono();
  
  const updatePath = config.basePath ? `${config.basePath}/update` : "/update";
  
  app.get(updatePath, async (c) => {
    const request = c.req.raw;
    const response = await handler(request);
    
    return new Response(response.body, {
      status: response.status,
      headers: response.headers
    });
  });

  return app;
}