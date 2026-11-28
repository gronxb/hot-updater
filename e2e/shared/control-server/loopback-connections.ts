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
 *
 * The controller closes each connection itself, not with
 * `connection: close`. A server that answers `connection: close` closes the
 * connection after the body, and the fetch of Node 24.22.1 (undici 7.30.1)
 * then asserts its parser isn't paused. The parser pauses whenever the body
 * is read slower than it arrives, as when the asset proxy streams a bundle to
 * the app, so the assertion crashed the controller (nodejs/undici#5360, fixed
 * on undici's main by nodejs/undici#5389 and nodejs/undici#5474 and in no
 * undici 7 release yet). Each request gets its own keep-alive connection
 * instead, which the server leaves open and the controller closes once the
 * response is read.
 */

const installed = Symbol.for("hot-updater-e2e.loopback-connections");

/** The part of an undici dispatcher the controller uses. */
export type LoopbackDispatcher = {
  close(): Promise<void>;
  destroy(): Promise<void>;
};

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

const requestUrl = (input: Parameters<typeof fetch>[0]): URL =>
  new URL(input instanceof Request ? input.url : String(input));

/**
 * A new Agent of the undici that runs Node's fetch. Node exports no undici
 * class, but loading its `Headers` installs an Agent as the process's global
 * dispatcher under undici's shared symbol.
 */
export function createLoopbackDispatcher(): LoopbackDispatcher {
  void globalThis.Headers;
  const globalDispatcher = Reflect.get(
    globalThis,
    Symbol.for("undici.globalDispatcher.1"),
  ) as object | undefined;
  const Agent = globalDispatcher?.constructor;
  if (Agent?.name !== "Agent") {
    throw new Error("Node's fetch has no undici Agent as its dispatcher.");
  }
  return new (Agent as new () => LoopbackDispatcher)();
}

export const closeLoopbackConnections =
  (
    fetchImplementation: typeof fetch,
    createDispatcher: () => LoopbackDispatcher = createLoopbackDispatcher,
  ): typeof fetch =>
  async (input, init) => {
    if (!isLoopbackHostname(requestUrl(input).hostname)) {
      return fetchImplementation(input, init);
    }
    const dispatcher = createDispatcher();
    try {
      const response = await fetchImplementation(input, {
        ...init,
        dispatcher,
      } as RequestInit);
      // Waits for the response's body, then closes the connection.
      dispatcher.close().catch(() => {});
      return response;
    } catch (error) {
      dispatcher.destroy().catch(() => {});
      throw error;
    }
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
