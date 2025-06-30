// Express server example using @hot-updater/server
import express from 'express';
import { HotUpdater, supabaseDatabase, supabaseStorage } from '@hot-updater/server';

// Convert Express request/response to Web API Request/Response
function toNodeHandler(handler: (request: Request) => Promise<Response>) {
  return async (req: express.Request, res: express.Response) => {
    try {
      const url = new URL(req.url!, `https://${req.headers.host}`);
      
      const headers = new Headers();
      Object.entries(req.headers).forEach(([key, value]) => {
        if (value) {
          headers.set(key, Array.isArray(value) ? value[0] : value);
        }
      });

      const body = req.method !== 'GET' && req.method !== 'HEAD' 
        ? JSON.stringify(req.body) 
        : undefined;

      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body,
      });

      const response = await handler(request);
      
      res.status(response.status);
      
      response.headers.forEach((value, key) => {
        res.set(key, value);
      });

      const responseBody = await response.text();
      res.send(responseBody);
    } catch (error) {
      console.error('Request handler error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

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

const app = express();
app.use(express.json());

// Mount the hot updater on all check-update routes
app.all('/api/check-update/*', toNodeHandler(hotUpdater.handler.bind(hotUpdater)));
app.all('/api/check-update', toNodeHandler(hotUpdater.handler.bind(hotUpdater)));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});