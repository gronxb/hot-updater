import { createServer } from "node:http";

import {
  createHttpTestClient,
  type HttpTestHandlers,
  type HttpTestServer,
} from "./httpTestClient";

/** Serve Web handlers over loopback TCP; contract tests use real fetch requests. */
export async function startHttpTestServer(
  handlers: HttpTestHandlers,
): Promise<HttpTestServer> {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url!, "http://127.0.0.1");
      const target = url.pathname.startsWith("/admin/") ? "admin" : "client";
      url.pathname = url.pathname.slice(target.length + 1);
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const response = await handlers[target](
        new Request(url, {
          method: incoming.method,
          headers,
          body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500);
      outgoing.end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing HTTP test server address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    ...createHttpTestClient({
      clientBaseUrl: `${baseUrl}/client`,
      adminBaseUrl: `${baseUrl}/admin`,
    }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
