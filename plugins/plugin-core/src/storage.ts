import type {
  StorageContentRange,
  StorageDeleteResult,
  StorageGetResult,
  StorageHeadResult,
  StorageIssueDownloadResult,
  StorageListResult,
  StorageObjectMetadata,
  StorageOperationContext,
  StoragePlugin,
  StoragePluginImplementation,
  StoragePutResult,
} from "./types/storage";

// allow: SIZE_OK — the canonical v2 boundary keeps validation and wrapping
// together without coupling the retained legacy factory to v2 internals.
export type * from "./types/storage";

export type StoragePluginErrorCode =
  | "invalid-input"
  | "invalid-uri"
  | "unsupported"
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "aborted"
  | "timeout"
  | "integrity"
  | "provider";

export class StoragePluginError extends Error {
  readonly code: StoragePluginErrorCode;
  declare readonly cause?: unknown;

  constructor(
    code: StoragePluginErrorCode,
    message: string,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super(message, options);
    this.name = "StoragePluginError";
    this.code = code;
  }
}

const fail = (
  code: "invalid-input" | "invalid-uri" | "provider",
  message: string,
  cause?: unknown,
): never => {
  throw new StoragePluginError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
};

const assertNonNegativeSafeInteger = (
  value: number,
  label: string,
  code: "invalid-input" | "provider" = "invalid-input",
): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code, `${label} must be a non-negative safe integer.`);
  }
};

const assertStorageUri = (storageUri: string, protocol: string): void => {
  if (typeof storageUri !== "string" || !URL.canParse(storageUri)) {
    fail("invalid-uri", "Storage URI must be an absolute URI.");
  }

  const actualProtocol = new URL(storageUri).protocol.slice(0, -1);
  const matches =
    actualProtocol === protocol ||
    (protocol === "http" && actualProtocol === "https");
  if (!matches) {
    fail("invalid-uri", `Storage URI protocol must match "${protocol}".`);
  }
};

const assertMetadata = (metadata: StorageObjectMetadata): void => {
  if (typeof metadata !== "object" || metadata === null) {
    fail("provider", "Storage provider returned invalid metadata.");
  }
  assertNonNegativeSafeInteger(
    metadata.contentLength,
    "contentLength",
    "provider",
  );
  if (
    metadata.lastModified !== undefined &&
    Number.isNaN(Date.parse(metadata.lastModified))
  ) {
    fail("provider", "Storage provider returned an invalid lastModified.");
  }
};

const assertContentRange = (range: StorageContentRange): void => {
  assertNonNegativeSafeInteger(range.start, "range.start", "provider");
  assertNonNegativeSafeInteger(range.end, "range.end", "provider");
  assertNonNegativeSafeInteger(
    range.totalLength,
    "range.totalLength",
    "provider",
  );
  if (range.end < range.start || range.end >= range.totalLength) {
    fail("provider", "Storage provider returned an invalid content range.");
  }
};

type StorageOperationResult =
  | StoragePutResult
  | StorageHeadResult
  | StorageGetResult
  | StorageDeleteResult
  | StorageIssueDownloadResult;

const assertOperationResult = (
  result: StorageOperationResult,
  protocol: string,
  kinds: readonly string[],
): void => {
  if (!kinds.includes(result.kind)) {
    fail("provider", "Storage provider returned an invalid outcome.");
  }
  switch (result.kind) {
    case "stored":
    case "already-exists":
      assertStorageUri(result.storageUri, protocol);
      return;
    case "found":
      assertStorageUri(result.storageUri, protocol);
      assertMetadata(result.metadata);
      return;
    case "not-found":
    case "deleted":
      return;
    case "issued":
      if (!URL.canParse(result.downloadUrl)) {
        fail("provider", "Storage provider returned an invalid download URL.");
      }
      if (
        result.expiresAt !== undefined &&
        Number.isNaN(Date.parse(result.expiresAt))
      ) {
        fail("provider", "Storage provider returned an invalid expiresAt.");
      }
      return;
    default:
      fail("provider", "Storage provider returned an invalid outcome.");
  }
};

const assertGetDetails = (result: StorageGetResult): void => {
  if (result.kind === "found") {
    if (!(result.body instanceof ReadableStream)) {
      fail("provider", "Storage provider returned an invalid body stream.");
    }
    if (result.range !== undefined) {
      assertContentRange(result.range);
      if (result.range.totalLength !== result.metadata.contentLength) {
        fail("provider", "Storage range length must match object metadata.");
      }
    }
  }
};

const assertListResult = (
  result: StorageListResult,
  protocol: string,
): void => {
  if (!Array.isArray(result.objects)) {
    fail("provider", "Storage provider returned an invalid list outcome.");
  }
  for (const object of result.objects) {
    if (typeof object.key !== "string") {
      fail("provider", "Storage provider returned an invalid list key.");
    }
    assertStorageUri(object.storageUri, protocol);
    assertMetadata(object.metadata);
  }
};

const mapProviderError = (error: unknown): StoragePluginError => {
  if (error instanceof StoragePluginError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new StoragePluginError("aborted", "Storage operation was aborted.", {
      cause: error,
    });
  }
  return new StoragePluginError("provider", "Storage provider failed.", {
    cause: error,
  });
};

const callProvider = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error) {
      throw mapProviderError(error);
    }
    throw mapProviderError(error);
  }
};

export const createStoragePlugin = <
  TContext extends StorageOperationContext = StorageOperationContext,
>(
  input: Readonly<{
    name: string;
    protocol: string;
    plugin: () => StoragePluginImplementation<TContext>;
  }>,
): StoragePlugin<TContext> => {
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    fail("invalid-input", "Storage plugin name must be non-empty.");
  }
  if (
    typeof input.protocol !== "string" ||
    !/^[a-z][a-z0-9+.-]*$/.test(input.protocol)
  ) {
    fail(
      "invalid-input",
      "Storage plugin protocol must be a lowercase URI scheme.",
    );
  }

  const name = input.name;
  const protocol = input.protocol;
  let implementation: StoragePluginImplementation<TContext>;
  try {
    implementation = input.plugin();
  } catch (error) {
    if (error instanceof Error) {
      throw mapProviderError(error);
    }
    throw mapProviderError(error);
  }

  const issueDownload = implementation.issueDownload;
  const list = implementation.list;
  const onUnmount = implementation.onUnmount;
  const plugin: StoragePlugin<TContext> = {
    name,
    protocol,
    async put(operationInput) {
      assertNonNegativeSafeInteger(
        operationInput.contentLength,
        "contentLength",
      );
      if (
        operationInput.body instanceof Uint8Array &&
        operationInput.body.byteLength !== operationInput.contentLength
      ) {
        fail("invalid-input", "contentLength must match the byte body length.");
      }
      return callProvider(async () => {
        const result = await implementation.put(operationInput);
        assertOperationResult(result, protocol, ["stored", "already-exists"]);
        return result;
      });
    },
    async head(operationInput) {
      assertStorageUri(operationInput.storageUri, protocol);
      return callProvider(async () => {
        const result = await implementation.head(operationInput);
        assertOperationResult(result, protocol, ["found", "not-found"]);
        return result;
      });
    },
    async get(operationInput) {
      assertStorageUri(operationInput.storageUri, protocol);
      if (operationInput.range !== undefined) {
        assertNonNegativeSafeInteger(operationInput.range.start, "range.start");
        if (operationInput.range.end !== undefined) {
          assertNonNegativeSafeInteger(operationInput.range.end, "range.end");
          if (operationInput.range.end < operationInput.range.start) {
            fail(
              "invalid-input",
              "range.end must be greater than or equal to range.start.",
            );
          }
        }
      }
      return callProvider(async () => {
        const result = await implementation.get(operationInput);
        assertOperationResult(result, protocol, ["found", "not-found"]);
        assertGetDetails(result);
        return result;
      });
    },
    async delete(operationInput) {
      assertStorageUri(operationInput.storageUri, protocol);
      return callProvider(async () => {
        const result = await implementation.delete(operationInput);
        assertOperationResult(result, protocol, ["deleted", "not-found"]);
        return result;
      });
    },
    ...(issueDownload
      ? {
          async issueDownload(operationInput) {
            assertStorageUri(operationInput.storageUri, protocol);
            if (operationInput.expiresInSeconds !== undefined) {
              assertNonNegativeSafeInteger(
                operationInput.expiresInSeconds,
                "expiresInSeconds",
              );
            }
            return callProvider(async () => {
              const result = await issueDownload(operationInput);
              assertOperationResult(result, protocol, ["issued"]);
              return result;
            });
          },
        }
      : {}),
    ...(list
      ? {
          async list(operationInput) {
            if (operationInput.limit !== undefined) {
              assertNonNegativeSafeInteger(operationInput.limit, "limit");
            }
            return callProvider(async () => {
              const result = await list(operationInput);
              assertListResult(result, protocol);
              return result;
            });
          },
        }
      : {}),
    ...(onUnmount
      ? {
          onUnmount: (() => {
            let cleanup: Promise<void> | undefined;
            return () => {
              cleanup ??= callProvider(async () => {
                await onUnmount();
              });
              return cleanup;
            };
          })(),
        }
      : {}),
  };
  return Object.freeze(plugin);
};
