export type HttpTestRequestInit = NonNullable<
  ConstructorParameters<typeof Request>[1]
>;
export type HttpTestRequest = (
  path: string,
  init?: HttpTestRequestInit,
) => Promise<Response>;

export interface HttpTestClient {
  readonly client: HttpTestRequest;
  readonly admin: HttpTestRequest;
}

export interface HttpTestServer extends HttpTestClient {
  readonly close: () => Promise<void>;
}

export type HttpTestHandlers = Record<
  "client" | "admin",
  (request: Request) => Promise<Response>
>;

/** Connect the same contract suite to any running HTTP server. */
export function createHttpTestClient(options: {
  readonly clientBaseUrl: string;
  readonly adminBaseUrl: string;
  readonly clientHeaders?: Record<string, string>;
  readonly adminHeaders?: Record<string, string>;
}): HttpTestClient {
  const endpoint =
    (baseUrl: string, headers: Record<string, string> = {}): HttpTestRequest =>
    (path, init) => {
      const requestHeaders = new Headers(headers);
      new Headers(init?.headers).forEach((value, key) =>
        requestHeaders.set(key, value),
      );
      return fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: requestHeaders,
      });
    };
  return {
    client: endpoint(options.clientBaseUrl, options.clientHeaders),
    admin: endpoint(options.adminBaseUrl, options.adminHeaders),
  };
}

/** Workers run the same HTTP contract through their Web Request/Response boundary. */
export function createHandlerHttpTestClient(
  handlers: HttpTestHandlers,
): HttpTestServer {
  const endpoint =
    (handler: HttpTestHandlers["client"]): HttpTestRequest =>
    (path, init) =>
      handler(new Request(`https://updates.example.com${path}`, init));
  return {
    client: endpoint(handlers.client),
    admin: endpoint(handlers.admin),
    close: async () => {},
  };
}
