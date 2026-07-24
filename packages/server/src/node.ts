import { MAX_EVENT_BODY_BYTES } from "./handlerEventIngestionRoutes";

/**
 * Node.js request/response types (compatible with Express, Connect, etc.)
 */
interface NodeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Uint8Array;
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

type HandlerHotUpdaterAPI = {
  readonly handler: (request: Request) => Promise<Response>;
};

export { HOT_UPDATER_SERVER_VERSION } from "./version";

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
 * // Preserve the original bytes so ingestion limits apply before JSON
 * // normalization.
 * app.use("/hot-updater", express.raw({ type: "application/json" }));
 *
 * // Mount hot-updater handler
 * app.all("/hot-updater/*", toNodeHandler(hotUpdater));
 * ```
 */
export function toNodeHandler(
  hotUpdater: HandlerHotUpdaterAPI,
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
      let body: RequestInit["body"];
      const requestBody = req.rawBody ?? req.body;
      if (
        req.method &&
        req.method !== "GET" &&
        req.method !== "HEAD" &&
        requestBody !== undefined
      ) {
        if (requestBody instanceof Uint8Array) {
          body = Uint8Array.from(requestBody);
        } else if (typeof requestBody === "string") {
          body = requestBody;
        } else {
          const path = new URL(url).pathname;
          const declaredLength = headers.get("Content-Length");
          const hasDeclaredLength =
            declaredLength !== null &&
            /^\d+$/.test(declaredLength) &&
            Number.isSafeInteger(Number(declaredLength));
          if (
            req.method === "POST" &&
            path.endsWith("/events") &&
            (!hasDeclaredLength ||
              Number(declaredLength) > MAX_EVENT_BODY_BYTES)
          ) {
            res.status(413);
            res.setHeader("Content-Type", "application/json");
            res.send(JSON.stringify({ error: "Payload too large" }));
            return;
          }
          body = JSON.stringify(requestBody);
        }
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
