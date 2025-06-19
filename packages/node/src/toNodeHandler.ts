import type { HotUpdaterHandler } from "./types";

export interface NodeHandlerOptions {
  path?: string;
}

/**
 * Converts a HotUpdater handler to a Node.js-compatible handler
 * Similar to better-auth's toNodeHandler pattern
 */
export function toNodeHandler(
  handler: HotUpdaterHandler, 
  options: NodeHandlerOptions = {}
): (req: any, res: any) => Promise<void> {
  const { path = "/update" } = options;

  return async (req: any, res: any) => {
    try {
      // Check if the request matches the update path
      if (req.url !== path && !req.url?.startsWith(`${path}?`)) {
        res.status(404).json({ error: "Not Found" });
        return;
      }

      // Only handle GET requests
      if (req.method !== "GET") {
        res.status(405).json({ error: "Method Not Allowed" });
        return;
      }

      // Convert Node.js request to Web Request
      const protocol = req.headers['x-forwarded-proto'] || 
                      (req.connection?.encrypted ? 'https' : 'http');
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url, `${protocol}://${host}`);

      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers as HeadersInit,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined
      });

      // Call the handler
      const response = await handler(request);
      const data = await response.json();

      // Send response
      res.status(response.status);
      
      // Set headers
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      res.json(data);
    } catch (error) {
      console.error("Error in toNodeHandler:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  };
}