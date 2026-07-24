import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterRouteContext,
  HotUpdaterServerRoute,
} from "./kernel/contracts";
import { executeKernelRequest } from "./kernel/execute";
import { compileRoutes } from "./kernel/routeCompiler";
import { toNodeHandler } from "./node";

class TestNodeResponse {
  readonly headers = new Headers();
  body = "";
  statusCode = 0;

  end(): void {}

  send(body: string): void {
    this.body = body;
  }

  setHeader(name: string, value: string | string[]): void {
    this.headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  status(code: number): TestNodeResponse {
    this.statusCode = code;
    return this;
  }
}

class LazyNodeRequest extends Readable {
  readonly headers = { host: "example.com" };
  readonly method = "POST";
  readonly protocol = "https";
  readonly url = "/api/protected";
  readCount = 0;

  get body(): never {
    throw new Error("parsed body accessed");
  }

  get rawBody(): never {
    throw new Error("raw body accessed");
  }

  get(name: string): string | undefined {
    return name === "host" ? "example.com" : undefined;
  }

  override _read(): void {
    this.readCount += 1;
    this.push(Buffer.from("secret body"));
    this.push(null);
  }
}

const protectedRoute = (
  parse: (request: Request) => Promise<undefined>,
  handle: (
    context: HotUpdaterRouteContext,
    input: undefined,
  ) => Promise<Response>,
): HotUpdaterServerRoute<undefined> => ({
  access: { kind: "protected" },
  id: "protected",
  input: { parse },
  method: "POST",
  path: "/protected",
  requestPolicy: { maximumBodyBytes: 64 },
  handle,
});

describe("Node adapter security", () => {
  it("keeps a Node stream lazy through authentication denial", async () => {
    // Given
    const request = new LazyNodeRequest();
    const response = new TestNodeResponse();
    const parse = vi.fn(async () => undefined);
    const handle = vi.fn(async () => new Response(null, { status: 204 }));
    const authentication: HotUpdaterAuthenticationProvider = {
      id: "auth",
      async authenticate() {
        return { kind: "anonymous" };
      },
    };
    const router = compileRoutes([protectedRoute(parse, handle)]);
    const middleware = toNodeHandler({
      handler(webRequest) {
        return executeKernelRequest({
          authentication,
          basePath: "/api",
          middleware: [],
          request: webRequest,
          router,
        });
      },
    });

    // When
    await middleware(request, response);

    // Then
    expect(response.statusCode).toBe(401);
    expect(request.readCount).toBe(0);
    expect(parse).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects a pre-parsed object even when Content-Length is present", async () => {
    // Given
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const response = new TestNodeResponse();
    const middleware = toNodeHandler({ handler });
    const request = {
      body: { payload: "already parsed" },
      get(name: string) {
        return name === "host" ? "example.com" : undefined;
      },
      headers: {
        "content-length": "28",
        host: "example.com",
      },
      method: "POST",
      protocol: "https",
      url: "/api/protected",
    };

    // When
    await middleware(request, response);

    // Then
    expect(response.statusCode).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });
});
