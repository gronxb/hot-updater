// New Cloudflare Worker using @hot-updater/server
import { HotUpdater, d1Database, r2Storage } from "@hot-updater/server";

type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hotUpdater = new HotUpdater({
      database: d1Database({ database: env.DB }),
      storage: r2Storage({ bucket: env.BUCKET, jwtSecret: env.JWT_SECRET })
    });
    
    return hotUpdater.handler(request);
  }
};