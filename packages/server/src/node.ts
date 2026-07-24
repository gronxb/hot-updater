import { Readable } from "node:stream";

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
}

interface NodeResponse {
  status(code: number): NodeResponse;
  setHeader(name: string, value: string | string[]): void;
  send(body: string): void;
  end(): void;
}

type HandlerHotUpdaterAPI = {
  readonly handler: (request: Request) => Promise<Response>;
};

type NodeBodyDecision =
  | { readonly kind: "body"; readonly value?: RequestInit["body"] }
  | { readonly kind: "reject" };

const isBodyMethod = (method: string): boolean =>
  method !== "GET" && method !== "HEAD";

const readNodeBody = (
  request: NodeRequest,
  method: string,
): NodeBodyDecision => {
  if (!isBodyMethod(method)) return { kind: "body" };
  if (request instanceof Readable && !request.readableEnded) {
    return { kind: "body", value: Readable.toWeb(request) };
  }

  const parsedBody = request.rawBody ?? request.body;
  if (parsedBody === undefined) return { kind: "body" };
  if (parsedBody instanceof Uint8Array) {
    return {
      kind: "body",
      value: Uint8Array.from(parsedBody),
    };
  }
  if (typeof parsedBody === "string") {
    return { kind: "body", value: parsedBody };
  }

  return { kind: "reject" };
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
 * // Mount before body parsers. The adapter forwards the unread Node request
 * // as a lazy Web stream, so protected routes authenticate before any body
 * // bytes are consumed.
 * app.all("/hot-updater/*", toNodeHandler(hotUpdater));
 *
 * // Register parsers only for routes handled after Hot Updater.
 * app.use(express.json());
 * ```
 */
export function toNodeHandler(
  hotUpdater: HandlerHotUpdaterAPI,
): (req: NodeRequest, res: NodeResponse) => Promise<void> {
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

      const method = req.method || "GET";
      const body = readNodeBody(req, method);
      if (body.kind === "reject") {
        res.status(413);
        res.setHeader("Content-Type", "application/json");
        res.send(JSON.stringify({ error: "Payload too large" }));
        return;
      }

      // Create Web Request
      const webRequest =
        body.value === undefined
          ? new globalThis.Request(url, { headers, method })
          : new globalThis.Request(url, {
              body: body.value,
              duplex: "half",
              headers,
              method,
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
    } catch {
      // Handle errors gracefully
      res.status(500);
      res.send("Internal Server Error");
    }
  };
}
