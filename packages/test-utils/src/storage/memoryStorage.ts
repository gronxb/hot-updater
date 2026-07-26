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

export const storageTestContext: StorageOperationContext = Object.freeze({
  target: "node",
  environment: Object.freeze({}),
  bindings: Object.freeze({}),
});

const storageUriForKey = (key: string): string => {
  if (key.length === 0) {
    throw new StoragePluginError("invalid-input", "Storage key is empty.");
  }
  return `memory://storage/${key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
};

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
  const cancellationState: { promise?: Promise<void> } = {};
  const cancel = (): void => {
    cancellationState.promise ??= reader.cancel();
  };

  try {
    if (signal?.aborted === true) {
      cancel();
      await cancellationState.promise;
      throw new StoragePluginError("aborted", "Storage put was aborted.");
    }
    signal?.addEventListener("abort", cancel, { once: true });

    while (true) {
      const next = await reader.read();
      if (cancellationState.promise !== undefined) {
        await cancellationState.promise;
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

export const createMemoryStoragePlugin = <
  TContext extends StorageOperationContext = StorageOperationContext,
>(): StoragePlugin<TContext> => {
  const objects = new Map<string, StoredObject>();
  const reservations = new Set<string>();

  return createStoragePlugin<TContext>({
    name: "memoryStorage",
    protocol: "memory",
    plugin: () => ({
      async put(input) {
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
          const custom =
            input.metadata === undefined
              ? undefined
              : Object.freeze({ ...input.metadata });
          const metadata: StorageObjectMetadata = Object.freeze({
            contentLength: body.byteLength,
            ...(input.contentType === undefined
              ? {}
              : { contentType: input.contentType }),
            ...(custom === undefined ? {} : { custom }),
          });
          objects.set(storageUri, { body, metadata });
          return { kind: "stored", storageUri };
        } finally {
          if (createOnly) {
            reservations.delete(storageUri);
          }
        }
      },
      async head(input) {
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
