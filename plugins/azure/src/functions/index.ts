import type { HttpHandler, HttpRequest } from "@azure/functions";
import type { CreateHotUpdaterOptions, HotUpdaterAPI } from "@hot-updater/server/runtime";

export { azureBlobStorage } from "../azureBlobStorage";
export { azureBlobDatabase } from "../azureBlobDatabase";

export type { AzureBlobStorageConfig } from "../azureBlobStorage";
export type { AzureBlobDatabaseConfig } from "../azureBlobDatabase";

export interface CreateAzureFunctionsHandlerOptions<TContext = unknown>
  extends CreateHotUpdaterOptions<TContext> {}

/**
 * Creates an Azure Functions v4 HTTP handler that wraps a Hot Updater server.
 *
 * Azure Functions v4 (Node.js programming model v4) passes an `HttpRequest`
 * which implements the Web Standard `Request` interface, and expects an
 * `HttpResponseInit` or a Web Standard `Response` back.
 *
 * Since `createHotUpdater` already returns a standard `Request -> Response`
 * handler, we can pass the Azure Functions request directly.
 *
 * @example
 * ```typescript
 * import { app } from "@azure/functions";
 * import { createAzureFunctionsHandler, azureBlobStorage, azureBlobDatabase } from "@hot-updater/azure/functions";
 *
 * const handler = createAzureFunctionsHandler({
 *   database: azureBlobDatabase({ ... }),
 *   storages: [azureBlobStorage({ ... })],
 *   basePath: "/api/hot-updater",
 * });
 *
 * app.http("hotUpdater", {
 *   methods: ["GET", "POST", "PATCH", "DELETE"],
 *   authLevel: "anonymous",
 *   route: "hot-updater/{*path}",
 *   handler,
 * });
 * ```
 */
export function createAzureFunctionsHandler(
  hotUpdater: HotUpdaterAPI,
): HttpHandler {
  return async (request: HttpRequest) => {
    // Azure Functions v4 HttpRequest implements the Web Standard Request
    // interface, so we can pass it directly to the Hot Updater handler.
    return hotUpdater.handler(request as unknown as Request);
  };
}
