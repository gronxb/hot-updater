/**
 * Node.js request/response types (compatible with Express, Connect, etc.)
 */
interface NodeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: unknown;
  protocol?: string;
  get?(name: string): string | undefined;
  [Symbol.asyncIterator]?(): AsyncIterator<unknown>;
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

const textEncoder = new TextEncoder();

function encodeRawBody(value: unknown): Uint8Array {
  if (typeof value === "string") return textEncoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  throw new TypeError("Unsupported raw request body.");
}

function encodeParsedBody(value: unknown): Uint8Array {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return encodeRawBody(value);
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined
    ? new Uint8Array()
    : textEncoder.encode(serialized);
}

function createLazyNodeBody(request: NodeRequest): ReadableStream<Uint8Array> {
  let initialized = false;
  let iterator: AsyncIterator<unknown> | undefined;

  return new ReadableStream<Uint8Array>(
    {
      async cancel(reason) {
        await iterator?.return?.(reason);
      },
      async pull(controller) {
        try {
          if (!initialized) {
            initialized = true;
            const rawBody = request.rawBody;
            if (rawBody !== undefined) {
              controller.enqueue(encodeRawBody(rawBody));
              controller.close();
              return;
            }

            const parsedBody = request.body;
            if (parsedBody !== undefined) {
              controller.enqueue(encodeParsedBody(parsedBody));
              controller.close();
              return;
            }

            const iteratorFactory = request[Symbol.asyncIterator];
            if (typeof iteratorFactory !== "function") {
              controller.close();
              return;
            }
            iterator = Reflect.apply(iteratorFactory, request, []);
          }

          const result = await iterator?.next();
          if (result === undefined || result.done) {
            controller.close();
            return;
          }
          controller.enqueue(encodeRawBody(result.value));
        } catch (error) {
          controller.error(error);
        }
      },
    },
    { highWaterMark: 0 },
  );
}

function requestBody(
  request: NodeRequest,
  method: string,
): ReadableStream<Uint8Array> | undefined {
  if (method === "GET" || method === "HEAD") return undefined;
  if (
    !("rawBody" in request) &&
    !("body" in request) &&
    !(Symbol.asyncIterator in request)
  ) {
    return undefined;
  }
  return createLazyNodeBody(request);
}

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
 * // Mount before general body parsers so protected routes authenticate first.
 * app.all("/hot-updater/*", toNodeHandler(hotUpdater));
 * app.use(express.json());
 * ```
 */
export function toNodeHandler(
  hotUpdater: HandlerHotUpdaterAPI,
): (req: NodeRequest, res: NodeResponse, next?: unknown) => Promise<void> {
  return async (req: NodeRequest, res: NodeResponse) => {
    try {
      const protocol = req.protocol || "http";
      const host = req.get?.("host") || "localhost";
      const url = `${protocol}://${host}${req.url || "/"}`;

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
      }

      const method = req.method || "GET";
      const body = requestBody(req, method);
      const init: RequestInit & { readonly duplex?: "half" } = {
        method,
        headers,
        body,
        ...(body === undefined ? {} : { duplex: "half" }),
      };
      const webRequest = new globalThis.Request(url, init);

      const response = await hotUpdater.handler(webRequest);

      res.status(response.status);

      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      const text = await response.text();
      if (text) {
        res.send(text);
      } else {
        res.end();
      }
    } catch (error) {
      console.error("Hot Updater handler error:", error);
      res.status(500);
      res.setHeader("cache-control", "private, no-store");
      res.setHeader("content-type", "application/json");
      res.send(JSON.stringify({ error: "Internal server error" }));
    }
  };
}
