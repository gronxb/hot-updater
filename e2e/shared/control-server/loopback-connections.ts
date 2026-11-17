/**
 * The controller opens a new connection for every request to a loopback
 * server, such as the local provider, and closes it after the response.
 *
 * A pooled keep-alive socket can be reset by a Node server. When the server's
 * event loop stalls past the socket's idle deadline (`keepAliveTimeout` plus
 * `keepAliveTimeoutBuffer`, 6 s on Node 24), the server runs the expired
 * timer before it reads the request already waiting on that socket, and
 * destroys the socket with the request unread. The client gets
 * `read ECONNRESET` ("fetch failed"). The local provider has stalled that
 * long in E2E runs, and the socket fetch picks may have been left by any
 * caller, such as the proxied `POST /hot-updater/events`, so every request to
 * that origin must close its connection. A new connection has no idle timer
 * and waits in the accept queue until the server reads it.
 */

const installed = Symbol.for("hot-updater-e2e.loopback-connections");

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

const requestUrl = (input: Parameters<typeof fetch>[0]): URL =>
  new URL(input instanceof Request ? input.url : String(input));

export const closeLoopbackConnections =
  (fetchImplementation: typeof fetch): typeof fetch =>
  (input, init) => {
    if (!isLoopbackHostname(requestUrl(input).hostname)) {
      return fetchImplementation(input, init);
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("connection", "close");
    return fetchImplementation(input, { ...init, headers });
  };

/** Wraps the process's `fetch` once, before any request reaches a server. */
export function closeLoopbackConnectionsInProcess(): void {
  if (Reflect.get(globalThis.fetch, installed) === true) return;
  const wrapped = closeLoopbackConnections(globalThis.fetch.bind(globalThis));
  Reflect.set(wrapped, installed, true);
  globalThis.fetch = wrapped;
}

/**
 * The provider's connection headers describe the controller's connection to
 * it, not the app's connection to the controller.
 */
export const headersForApp = (headers: Headers): Headers => {
  const forwarded = new Headers(headers);
  forwarded.delete("connection");
  forwarded.delete("keep-alive");
  return forwarded;
};
