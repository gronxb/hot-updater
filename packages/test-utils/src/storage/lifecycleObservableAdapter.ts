import {
  createStoragePlugin,
  type StorageOperationContext,
  type StoragePlugin,
} from "@hot-updater/plugin-core/storage";

export type LifecycleSnapshot = Readonly<{
  clientCreations: number;
  clientDisposals: number;
  inputStreamCancellations: number;
  outputStreamCancellations: number;
  unmountCount: number;
}>;

export type LifecycleHarness = Readonly<{
  plugin: StoragePlugin<StorageOperationContext>;
  snapshot: () => LifecycleSnapshot;
}>;

type LifecycleHarnessOptions = Readonly<{
  failPut?: boolean;
}>;

type LifecycleClient = {
  readonly objects: Map<string, Uint8Array>;
  disposed: boolean;
};

const contextUri = (key: string): string =>
  `lifecycle://storage/${encodeURIComponent(key)}`;

const collectBody = async (
  body: Uint8Array | ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onCancel: () => void,
): Promise<Uint8Array> => {
  if (body instanceof Uint8Array) {
    if (signal?.aborted === true) {
      throw new DOMException("cancelled", "AbortError");
    }
    return new Uint8Array(body);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    if (cancellation === undefined) {
      onCancel();
      cancellation = reader.cancel();
    }
  };

  try {
    if (signal?.aborted === true) {
      cancel();
    } else {
      signal?.addEventListener("abort", cancel, { once: true });
    }
    while (cancellation === undefined) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      chunks.push(next.value);
      byteLength += next.value.byteLength;
    }
    if (cancellation !== undefined) {
      await cancellation;
      throw new DOMException("cancelled", "AbortError");
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

export const createLifecycleObservableHarness = (
  options: LifecycleHarnessOptions = {},
): LifecycleHarness => {
  let client: LifecycleClient | undefined;
  let clientCreations = 0;
  let clientDisposals = 0;
  let inputStreamCancellations = 0;
  let outputStreamCancellations = 0;
  let unmountCount = 0;

  const getClient = (): LifecycleClient => {
    if (client === undefined) {
      clientCreations += 1;
      client = { objects: new Map(), disposed: false };
    }
    return client;
  };

  const plugin = createStoragePlugin({
    name: "lifecycleObservableStorage",
    protocol: "lifecycle",
    plugin: () => ({
      async put(input) {
        const activeClient = getClient();
        if (options.failPut === true) {
          throw new Error("observable provider failure");
        }
        const body = await collectBody(input.body, input.signal, () => {
          inputStreamCancellations += 1;
        });
        activeClient.objects.set(contextUri(input.key), body);
        return { kind: "stored", storageUri: contextUri(input.key) };
      },
      async head(input) {
        const body = getClient().objects.get(input.storageUri);
        return body === undefined
          ? { kind: "not-found" }
          : {
              kind: "found",
              storageUri: input.storageUri,
              metadata: { contentLength: body.byteLength },
            };
      },
      async get(input) {
        const body = getClient().objects.get(input.storageUri);
        if (body === undefined) {
          return { kind: "not-found" };
        }
        return {
          kind: "found",
          storageUri: input.storageUri,
          metadata: { contentLength: body.byteLength },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(body));
            },
            cancel() {
              outputStreamCancellations += 1;
            },
          }),
        };
      },
      async delete(input) {
        return getClient().objects.delete(input.storageUri)
          ? { kind: "deleted" }
          : { kind: "not-found" };
      },
      onUnmount() {
        unmountCount += 1;
        if (client !== undefined && !client.disposed) {
          client.disposed = true;
          client.objects.clear();
          clientDisposals += 1;
        }
      },
    }),
  });

  return {
    plugin,
    snapshot: () => ({
      clientCreations,
      clientDisposals,
      inputStreamCancellations,
      outputStreamCancellations,
      unmountCount,
    }),
  };
};
