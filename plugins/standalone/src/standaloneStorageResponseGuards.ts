import {
  StoragePluginError,
  type StorageContentRange,
  type StorageObjectMetadata,
} from "@hot-updater/plugin-core/storage";

import {
  decodeStandaloneStorageHeader,
  STANDALONE_STORAGE_V2,
} from "./standaloneStorageContract";

const parseLength = (value: string | null): number | undefined => {
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const parseCustomMetadata = (
  value: string | undefined,
): Readonly<Record<string, string>> | undefined => {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((item) => typeof item !== "string")
    ) {
      return undefined;
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(parsed).map(([key, item]) => [key, String(item)]),
      ),
    );
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

const invalidResponse = (): StoragePluginError =>
  new StoragePluginError(
    "provider",
    "Standalone storage returned an invalid response.",
  );

export const parseStandaloneStorageUri = (response: Response): string => {
  const storageUri = decodeStandaloneStorageHeader(
    response.headers,
    STANDALONE_STORAGE_V2.headers.storageUri,
  );
  if (storageUri === undefined || !URL.canParse(storageUri)) {
    throw invalidResponse();
  }
  return storageUri;
};

export const parseStandaloneStorageMetadata = (
  response: Response,
): StorageObjectMetadata => {
  const contentLength = parseLength(
    response.headers.get(STANDALONE_STORAGE_V2.headers.contentLength),
  );
  const custom = parseCustomMetadata(
    decodeStandaloneStorageHeader(
      response.headers,
      STANDALONE_STORAGE_V2.headers.metadata,
    ),
  );
  if (contentLength === undefined || custom === undefined) {
    throw invalidResponse();
  }
  const contentType = response.headers.get("content-type") ?? undefined;
  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;
  return Object.freeze({
    contentLength,
    ...(contentType === undefined ? {} : { contentType }),
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
    custom,
  });
};

export const parseStandaloneContentRange = (
  response: Response,
): StorageContentRange | undefined => {
  const value = response.headers.get("content-range");
  if (value === null) return undefined;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value);
  if (match === null) throw invalidResponse();
  const start = Number(match[1]);
  const end = Number(match[2]);
  const totalLength = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(totalLength) ||
    start < 0 ||
    end < start ||
    end >= totalLength
  ) {
    throw invalidResponse();
  }
  return Object.freeze({ start, end, totalLength });
};

export const guardStandaloneResponseBody = (
  body: ReadableStream<Uint8Array> | null,
  expectedLength: number,
): ReadableStream<Uint8Array> => {
  if (body === null) throw invalidResponse();
  const reader = body.getReader();
  let received = 0;
  let readerReleased = false;
  const releaseReader = () => {
    if (readerReleased) return;
    reader.releaseLock();
    readerReleased = true;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (received !== expectedLength) {
            controller.error(
              new StoragePluginError(
                "integrity",
                "Standalone storage response was truncated.",
              ),
            );
          } else {
            controller.close();
          }
          releaseReader();
          return;
        }
        received += next.value.byteLength;
        if (received > expectedLength) {
          try {
            await reader.cancel();
          } finally {
            releaseReader();
          }
          controller.error(
            new StoragePluginError(
              "integrity",
              "Standalone storage response exceeded its declared length.",
            ),
          );
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        releaseReader();
        throw error;
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });
};

export const readStandaloneDeliveryResponse = async (
  response: Response,
): Promise<Readonly<{ downloadUrl: string; expiresAt?: string }>> => {
  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidResponse();
    throw error;
  }
  if (
    typeof result !== "object" ||
    result === null ||
    typeof Reflect.get(result, "downloadUrl") !== "string" ||
    !URL.canParse(Reflect.get(result, "downloadUrl"))
  ) {
    throw invalidResponse();
  }
  const downloadUrl = Reflect.get(result, "downloadUrl");
  const expiresAt = Reflect.get(result, "expiresAt");
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))
  ) {
    throw invalidResponse();
  }
  return Object.freeze({
    downloadUrl,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
};
