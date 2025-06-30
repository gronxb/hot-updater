import { createHandler } from "@hot-updater/node";
import { supabaseNodeDatabase, supabaseNodeStorage } from "./adapters";
import type { SupabaseNodeDatabaseConfig, SupabaseNodeStorageConfig } from "./adapters";

export interface SupabaseNodeConfig {
  database: SupabaseNodeDatabaseConfig;
  storage: SupabaseNodeStorageConfig;
}

export function createSupabaseHandler(config: SupabaseNodeConfig) {
  const database = supabaseNodeDatabase(config.database);
  const storage = supabaseNodeStorage(config.storage);

  return createHandler({
    database,
    storage: [storage]
  });
}

// Express.js integration example
export function createSupabaseExpressHandler(config: SupabaseNodeConfig) {
  const handler = createSupabaseHandler(config);
  
  return async (req: any, res: any) => {
    try {
      // Convert Express request to Web Request
      const url = new URL(req.url, `http://${req.get('host')}`);
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined
      });

      const response = await handler(request);
      const data = await response.json();
      
      res.status(response.status).json(data);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  };
}

// Next.js API route integration example  
export function createSupabaseNextHandler(config: SupabaseNodeConfig) {
  const handler = createSupabaseHandler(config);
  
  return async (req: any, res: any) => {
    try {
      // Convert Next.js request to Web Request
      const url = new URL(req.url, `http://${req.headers.host}`);
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers
      });

      const response = await handler(request);
      const data = await response.json();
      
      res.status(response.status).json(data);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  };
}