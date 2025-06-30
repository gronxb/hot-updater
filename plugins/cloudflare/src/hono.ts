import { Hono } from "hono";
import { createHandler } from "@hot-updater/node";
import { d1NodeDatabase, r2NodeStorage } from "./adapters";
import type { D1NodeDatabaseConfig, R2NodeStorageConfig } from "./adapters";

export interface CloudflareHonoConfig {
  database: D1NodeDatabaseConfig;
  storage: R2NodeStorageConfig;
  basePath?: string;
}

export function createCloudflareHonoApp(config: CloudflareHonoConfig): Hono {
  const database = d1NodeDatabase(config.database);
  const storage = r2NodeStorage(config.storage);

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