// Example: Cloudflare D1 + R2 (optimal combination)
import { HotUpdater } from '@hot-updater/plugin-core';
import { d1Database, r2Storage } from '@hot-updater/plugin-cloudflare/adapters';

type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

// Create HotUpdater instance in Cloudflare Worker context
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

// Cloudflare Worker implementation
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hotUpdater = createHotUpdater(env);
    return hotUpdater.handler(request);
  }
};

// Alternative: Pre-create instance (if env is available globally)
// export const hotUpdater = new HotUpdater({
//   database: d1Database({ database: globalThis.DB }),
//   storage: r2Storage({ 
//     bucket: globalThis.BUCKET,
//     jwtSecret: globalThis.JWT_SECRET 
//   })
// });
// 
// export default {
//   async fetch(request: Request): Promise<Response> {
//     return hotUpdater.handler(request);
//   }
// };