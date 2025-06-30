import { createHandler } from "@hot-updater/node";
import { d1NodeDatabase, r2NodeStorage } from "./adapters";
import type { D1NodeDatabaseConfig, R2NodeStorageConfig } from "./adapters";

export interface CloudflareNodeConfig {
  database: D1NodeDatabaseConfig;
  storage: R2NodeStorageConfig;
}

export function createCloudflareHandler(config: CloudflareNodeConfig) {
  const database = d1NodeDatabase(config.database);
  const storage = r2NodeStorage(config.storage);

  return createHandler({
    database,
    storage: [storage]
  });
}

// Cloudflare Workers integration (without Hono)
export function createCloudflareWorkerHandler(config: CloudflareNodeConfig) {
  const handler = createCloudflareHandler(config);
  
  return {
    async fetch(request: Request, env: any, ctx: any): Promise<Response> {
      const url = new URL(request.url);
      
      if (url.pathname === "/update" && request.method === "GET") {
        return handler(request);
      }
      
      return new Response("Not Found", { status: 404 });
    }
  };
}