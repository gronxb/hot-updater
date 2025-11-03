import type { HotUpdaterAPI } from "./types";

/**
 * Node.js request/response types (compatible with Express, Connect, etc.)
 */
interface NodeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  protocol?: string;
  get?(name: string): string | undefined;
  [key: string]: unknown;
}

interface NodeResponse {
  status(code: number): NodeResponse;
  setHeader(name: string, value: string | string[]): void;
  send(body: string): void;
  end(): void;
  [key: string]: unknown;
}

/**
 * Converts a Hot Updater handler to a Node.js-compatible middleware
 * Works with Express, Connect, and other frameworks using Node.js req/res
 *
 * @example
 * ```typescript
 * import { toNodeHandler } from "@hot-updater/server/node";
 * import express from "express";
 *
 * const app = express();
 *
 * // Mount middleware
 * app.use(express.json());
 *
 * // Mount hot-updater handler
 * app.all("/hot-updater/*", toNodeHandler(hotUpdater));
 * ```
 */
export function toNodeHandler(
  hotUpdater: HotUpdaterAPI,
): (req: any, res: any, next?: any) => Promise<void> {
  return async (req: NodeRequest, res: NodeResponse) => {
    try {
      // Build full URL
      const protocol = req.protocol || "http";
      const host = req.get?.("host") || "localhost";
      const url = `${protocol}://${host}${req.url || "/"}`;

      // Convert headers to Web Headers
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
      }

      // Handle request body
      let body: string | undefined;
      if (
        req.method &&
        req.method !== "GET" &&
        req.method !== "HEAD" &&
        req.body
      ) {
        // If body is already parsed (by express.json()), stringify it
        body = JSON.stringify(req.body);
      }

      // Create Web Request
      const webRequest = new globalThis.Request(url, {
        method: req.method || "GET",
        headers,
        body,
      });

      // Call hot-updater handler
      const response = await hotUpdater.handler(webRequest);

      // Set status code
      res.status(response.status);

      // Set headers
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      // Send response body
      const text = await response.text();
      if (text) {
        res.send(text);
      } else {
        res.end();
      }
    } catch (error) {
      // Handle errors gracefully
      console.error("Hot Updater handler error:", error);
      res.status(500);
      res.send("Internal Server Error");
    }
  };
}
