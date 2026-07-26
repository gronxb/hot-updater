import {
  StoragePluginError,
  type StorageOperationContext,
  type StoragePluginImplementation,
} from "@hot-updater/plugin-core/storage";

import {
  encodeStandaloneStorageHeader,
  STANDALONE_STORAGE_V2,
  type StandaloneStorageV2RouteName,
} from "./standaloneStorageContract";
import {
  guardStandaloneResponseBody,
  parseStandaloneContentRange,
  parseStandaloneStorageMetadata,
  parseStandaloneStorageUri,
  readStandaloneDeliveryResponse,
} from "./standaloneStorageResponseGuards";
import type { createStandaloneTransport } from "./standaloneTransport";

type RequestOptions = Parameters<
  ReturnType<typeof createStandaloneTransport>["request"]
>[1];

export type StandaloneStorageRequest = (
  routeName: StandaloneStorageV2RouteName,
  context: StorageOperationContext,
  options: RequestOptions,
) => Promise<Response>;

export class StandaloneStorageHttpError extends StoragePluginError {
  readonly status: number;

  constructor(status: number, code: StoragePluginError["code"]) {
    super(code, "Standalone storage request failed.");
    this.name = "StandaloneStorageHttpError";
    this.status = status;
  }
}

const requireOk = (response: Response): void => {
  if (response.ok) return;
  const code =
    response.status === 401
      ? "unauthorized"
      : response.status === 403
        ? "forbidden"
        : response.status === 429
          ? "rate-limited"
          : response.status === 408 || response.status === 504
            ? "timeout"
            : "provider";
  throw new StandaloneStorageHttpError(response.status, code);
};

export const createStandaloneStorageOperations = (
  request: StandaloneStorageRequest,
): StoragePluginImplementation => ({
  async put(input) {
    if (input.signal?.aborted === true) {
      if (input.body instanceof ReadableStream) await input.body.cancel();
      throw new StoragePluginError(
        "aborted",
        "Standalone storage put was aborted.",
      );
    }
    const response = await request("object", input.context, {
      method: "PUT",
      body: input.body,
      signal: input.signal,
      headerPolicy: {
        set: {
          [STANDALONE_STORAGE_V2.headers.key]: encodeStandaloneStorageHeader(
            input.key,
          ),
          [STANDALONE_STORAGE_V2.headers.metadata]:
            encodeStandaloneStorageHeader(JSON.stringify(input.metadata ?? {})),
          "content-length": String(input.contentLength),
          ...(input.contentType === undefined
            ? {}
            : { "content-type": input.contentType }),
          ...(input.condition === "create-only"
            ? { "if-none-match": "*" }
            : {}),
        },
      },
    });
    if (response.status === 409) {
      return {
        kind: "already-exists",
        storageUri: parseStandaloneStorageUri(response),
      };
    }
    requireOk(response);
    return {
      kind: "stored",
      storageUri: parseStandaloneStorageUri(response),
    };
  },
  async head(input) {
    const response = await request("object", input.context, {
      method: "HEAD",
      signal: input.signal,
      headerPolicy: {
        set: {
          [STANDALONE_STORAGE_V2.headers.storageUri]:
            encodeStandaloneStorageHeader(input.storageUri),
        },
      },
    });
    if (response.status === 404) return { kind: "not-found" };
    requireOk(response);
    return {
      kind: "found",
      storageUri: parseStandaloneStorageUri(response),
      metadata: parseStandaloneStorageMetadata(response),
    };
  },
  async get(input) {
    const range =
      input.range === undefined
        ? undefined
        : `bytes=${input.range.start}-${input.range.end ?? ""}`;
    const response = await request("object", input.context, {
      method: "GET",
      signal: input.signal,
      headerPolicy: {
        set: {
          [STANDALONE_STORAGE_V2.headers.storageUri]:
            encodeStandaloneStorageHeader(input.storageUri),
          ...(range === undefined ? {} : { range }),
        },
      },
    });
    if (response.status === 404) return { kind: "not-found" };
    requireOk(response);
    const metadata = parseStandaloneStorageMetadata(response);
    const contentRange = parseStandaloneContentRange(response);
    const expectedLength =
      contentRange === undefined
        ? metadata.contentLength
        : contentRange.end - contentRange.start + 1;
    return {
      kind: "found",
      storageUri: parseStandaloneStorageUri(response),
      metadata,
      body: guardStandaloneResponseBody(response.body, expectedLength),
      ...(contentRange === undefined ? {} : { range: contentRange }),
    };
  },
  async delete(input) {
    const response = await request("object", input.context, {
      method: "DELETE",
      signal: input.signal,
      headerPolicy: {
        set: {
          [STANDALONE_STORAGE_V2.headers.storageUri]:
            encodeStandaloneStorageHeader(input.storageUri),
        },
      },
    });
    if (response.status === 404) return { kind: "not-found" };
    requireOk(response);
    return { kind: "deleted" };
  },
  async issueDownload(input) {
    const response = await request("delivery", input.context, {
      method: "POST",
      signal: input.signal,
      headerPolicy: {
        set: {
          [STANDALONE_STORAGE_V2.headers.storageUri]:
            encodeStandaloneStorageHeader(input.storageUri),
          ...(input.expiresInSeconds === undefined
            ? {}
            : {
                [STANDALONE_STORAGE_V2.headers.expiresInSeconds]: String(
                  input.expiresInSeconds,
                ),
              }),
        },
      },
    });
    requireOk(response);
    const result = await readStandaloneDeliveryResponse(response);
    return { kind: "issued", ...result };
  },
  onUnmount() {
    return Promise.resolve();
  },
});
