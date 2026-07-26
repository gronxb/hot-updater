import {
  StoragePluginError,
  type StorageOperationContext,
  type StoragePlugin,
} from "@hot-updater/plugin-core/storage";

import {
  encodeStandaloneStorageHeader,
  STANDALONE_STORAGE_V2,
} from "./standaloneStorageContract";
import {
  parseStandaloneIntegerHeader,
  parseStandaloneMetadata,
  parseStandaloneRange,
  requireStandaloneStorageHeader,
  standaloneStorageErrorStatus,
  standaloneStorageMetadataHeaders,
} from "./standaloneStorageHandlerProtocol";

type ContextSource =
  | StorageOperationContext
  | ((request: Request) => StorageOperationContext);

export type StandaloneStorageHandlerOptions = Readonly<{
  storage: StoragePlugin;
  context: ContextSource;
  authorize?: (request: Request) => boolean | Promise<boolean>;
}>;

const resolveContext = (
  source: ContextSource,
  request: Request,
): StorageOperationContext =>
  typeof source === "function" ? source(request) : source;

export const createStandaloneStorageHandler =
  (
    options: StandaloneStorageHandlerOptions,
  ): ((request: Request) => Promise<Response | undefined>) =>
  async (request) => {
    const url = new URL(request.url);
    const isObject = url.pathname === STANDALONE_STORAGE_V2.routes.object;
    const isDelivery = url.pathname === STANDALONE_STORAGE_V2.routes.delivery;
    if (!isObject && !isDelivery) return undefined;
    if (
      options.authorize !== undefined &&
      !(await options.authorize(request))
    ) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const context = resolveContext(options.context, request);

    try {
      if (isDelivery) {
        if (request.method !== "POST") {
          return new Response(null, { status: 405 });
        }
        const issueDownload = options.storage.issueDownload;
        if (issueDownload === undefined) {
          throw new StoragePluginError(
            "unsupported",
            "Storage delivery is unsupported.",
          );
        }
        const result = await issueDownload({
          context,
          storageUri: requireStandaloneStorageHeader(
            request,
            STANDALONE_STORAGE_V2.headers.storageUri,
          ),
          expiresInSeconds: parseStandaloneIntegerHeader(
            request,
            STANDALONE_STORAGE_V2.headers.expiresInSeconds,
          ),
          signal: request.signal,
        });
        return Response.json({
          downloadUrl: result.downloadUrl,
          ...(result.expiresAt === undefined
            ? {}
            : { expiresAt: result.expiresAt }),
        });
      }

      switch (request.method) {
        case "PUT": {
          const contentLength = parseStandaloneIntegerHeader(
            request,
            "content-length",
          );
          if (contentLength === undefined || request.body === null) {
            throw new StoragePluginError(
              "invalid-input",
              "Standalone storage request is invalid.",
            );
          }
          const result = await options.storage.put({
            context,
            key: requireStandaloneStorageHeader(
              request,
              STANDALONE_STORAGE_V2.headers.key,
            ),
            body: request.body,
            contentLength,
            contentType: request.headers.get("content-type") ?? undefined,
            metadata: parseStandaloneMetadata(request),
            condition:
              request.headers.get("if-none-match") === "*"
                ? "create-only"
                : undefined,
            signal: request.signal,
          });
          return new Response(null, {
            status: result.kind === "already-exists" ? 409 : 201,
            headers: {
              [STANDALONE_STORAGE_V2.headers.storageUri]:
                encodeStandaloneStorageHeader(result.storageUri),
            },
          });
        }
        case "HEAD": {
          const storageUri = requireStandaloneStorageHeader(
            request,
            STANDALONE_STORAGE_V2.headers.storageUri,
          );
          const result = await options.storage.head({
            context,
            storageUri,
            signal: request.signal,
          });
          return result.kind === "not-found"
            ? new Response(null, { status: 404 })
            : new Response(null, {
                status: 200,
                headers: standaloneStorageMetadataHeaders(
                  result.metadata,
                  result.storageUri,
                ),
              });
        }
        case "GET": {
          const storageUri = requireStandaloneStorageHeader(
            request,
            STANDALONE_STORAGE_V2.headers.storageUri,
          );
          const result = await options.storage.get({
            context,
            storageUri,
            range: parseStandaloneRange(request),
            signal: request.signal,
          });
          if (result.kind === "not-found") {
            return new Response(null, { status: 404 });
          }
          const headers = standaloneStorageMetadataHeaders(
            result.metadata,
            result.storageUri,
          );
          const returnedLength =
            result.range === undefined
              ? result.metadata.contentLength
              : result.range.end - result.range.start + 1;
          headers.set("content-length", String(returnedLength));
          if (result.range !== undefined) {
            headers.set(
              "content-range",
              `bytes ${result.range.start}-${result.range.end}/${result.range.totalLength}`,
            );
          }
          return new Response(result.body, {
            status: result.range === undefined ? 200 : 206,
            headers,
          });
        }
        case "DELETE": {
          const result = await options.storage.delete({
            context,
            storageUri: requireStandaloneStorageHeader(
              request,
              STANDALONE_STORAGE_V2.headers.storageUri,
            ),
            signal: request.signal,
          });
          return new Response(null, {
            status: result.kind === "deleted" ? 204 : 404,
          });
        }
        default:
          return new Response(null, { status: 405 });
      }
    } catch (error) {
      if (error instanceof StoragePluginError) {
        return Response.json(
          { error: "Standalone storage request failed." },
          { status: standaloneStorageErrorStatus(error) },
        );
      }
      throw error;
    }
  };

export { STANDALONE_STORAGE_V2 } from "./standaloneStorageContract";
