import {
  createStoragePlugin,
  StoragePluginError,
  type StorageObjectMetadata,
  type StorageOperationContext,
  type StoragePlugin,
} from "@hot-updater/plugin-core/storage";

type StoredObject = Readonly<{
  body: Uint8Array;
  metadata: StorageObjectMetadata;
}>;

export type MockStorageOperation = "put" | "head" | "get" | "delete";

export type MockStorageInitialObject = Readonly<{
  key: string;
  body: Uint8Array;
  contentType?: string;
  metadata?: Readonly<Record<string, string>>;
}>;

export type MockStorageConfig<
  TContext extends StorageOperationContext = StorageOperationContext,
> = Readonly<{
  initialObjects?: readonly MockStorageInitialObject[];
  failures?: Readonly<Partial<Record<MockStorageOperation, unknown>>>;
  assertContext?: (context: TContext, operation: MockStorageOperation) => void;
}>;

const storageUriForKey = (key: string): string => {
  if (key.length === 0) {
    throw new StoragePluginError("invalid-input", "Storage key is empty.");
  }
  return `storage://mock/${key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
};

const metadataFor = (
  body: Uint8Array,
  contentType?: string,
  custom?: Readonly<Record<string, string>>,
): StorageObjectMetadata =>
  Object.freeze({
    contentLength: body.byteLength,
    ...(contentType === undefined ? {} : { contentType }),
    ...(custom === undefined ? {} : { custom: Object.freeze({ ...custom }) }),
  });

const readBody = async (
  body: Uint8Array | ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  if (body instanceof Uint8Array) {
    if (signal?.aborted === true) {
      throw new StoragePluginError("aborted", "Storage put was aborted.");
    }
    return new Uint8Array(body);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const cancellation: { promise?: Promise<void> } = {};
  const cancel = (): void => {
    cancellation.promise ??= reader.cancel();
  };

  try {
    if (signal?.aborted === true) {
      cancel();
      await cancellation.promise;
      throw new StoragePluginError("aborted", "Storage put was aborted.");
    }
    signal?.addEventListener("abort", cancel, { once: true });
    while (true) {
      const next = await reader.read();
      if (cancellation.promise !== undefined) {
        await cancellation.promise;
        throw new StoragePluginError("aborted", "Storage put was aborted.");
      }
      if (next.done) {
        break;
      }
      chunks.push(next.value);
      byteLength += next.value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const streamBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });

export const mockStorage = <
  TContext extends StorageOperationContext = StorageOperationContext,
>(
  config: MockStorageConfig<TContext> = {},
): StoragePlugin<TContext> => {
  const objects = new Map<string, StoredObject>();
  const reservations = new Set<string>();
  for (const initial of config.initialObjects ?? []) {
    const body = new Uint8Array(initial.body);
    objects.set(storageUriForKey(initial.key), {
      body,
      metadata: metadataFor(body, initial.contentType, initial.metadata),
    });
  }

  const prepare = (
    operation: MockStorageOperation,
    context: TContext,
  ): void => {
    config.assertContext?.(context, operation);
    const failure = config.failures?.[operation];
    if (failure !== undefined) {
      throw failure;
    }
  };

  return createStoragePlugin<TContext>({
    name: "mockStorage",
    protocol: "storage",
    plugin: () => ({
      async put(input) {
        prepare("put", input.context);
        const storageUri = storageUriForKey(input.key);
        const createOnly = input.condition === "create-only";
        if (
          createOnly &&
          (objects.has(storageUri) || reservations.has(storageUri))
        ) {
          return { kind: "already-exists", storageUri };
        }
        if (createOnly) {
          reservations.add(storageUri);
        }
        try {
          const body = await readBody(input.body, input.signal);
          if (body.byteLength !== input.contentLength) {
            throw new StoragePluginError(
              "integrity",
              "Storage body length does not match contentLength.",
            );
          }
          objects.set(storageUri, {
            body,
            metadata: metadataFor(body, input.contentType, input.metadata),
          });
          return { kind: "stored", storageUri };
        } finally {
          if (createOnly) {
            reservations.delete(storageUri);
          }
        }
      },
      async head(input) {
        prepare("head", input.context);
        const object = objects.get(input.storageUri);
        return object === undefined
          ? { kind: "not-found" }
          : {
              kind: "found",
              storageUri: input.storageUri,
              metadata: object.metadata,
            };
      },
      async get(input) {
        prepare("get", input.context);
        if (input.signal?.aborted === true) {
          throw new StoragePluginError("aborted", "Storage get was aborted.");
        }
        const object = objects.get(input.storageUri);
        if (object === undefined) {
          return { kind: "not-found" };
        }
        if (input.range === undefined) {
          return {
            kind: "found",
            storageUri: input.storageUri,
            body: streamBytes(object.body),
            metadata: object.metadata,
          };
        }
        const end = Math.min(
          input.range.end ?? object.body.byteLength - 1,
          object.body.byteLength - 1,
        );
        if (input.range.start > end) {
          return { kind: "not-found" };
        }
        return {
          kind: "found",
          storageUri: input.storageUri,
          body: streamBytes(object.body.slice(input.range.start, end + 1)),
          metadata: object.metadata,
          range: {
            start: input.range.start,
            end,
            totalLength: object.body.byteLength,
          },
        };
      },
      async delete(input) {
        prepare("delete", input.context);
        return objects.delete(input.storageUri)
          ? { kind: "deleted" }
          : { kind: "not-found" };
      },
      onUnmount() {
        objects.clear();
        reservations.clear();
      },
    }),
  });
};
