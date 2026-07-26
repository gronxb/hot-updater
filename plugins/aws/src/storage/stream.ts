import { StoragePluginError } from "@hot-updater/plugin-core/storage";

export const retainClientThroughStream = (
  source: ReadableStream<Uint8Array>,
  release: () => void,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  let abortError: StoragePluginError | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let sourceCancellation: Promise<void> | undefined;
  let settled = false;
  const cancelSource = (reason?: unknown): Promise<void> => {
    sourceCancellation ??= reader.cancel(reason);
    return sourceCancellation;
  };
  const settle = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    signal?.removeEventListener("abort", abort);
    release();
  };
  const abort = (): void => {
    if (settled || abortError !== undefined) {
      return;
    }
    abortError = new StoragePluginError(
      "aborted",
      "AWS S3 response stream was aborted.",
      { cause: signal?.reason },
    );
    controller?.error(abortError);
    void cancelSource(abortError)
      .catch(() => undefined)
      .finally(settle);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    async pull(streamController) {
      try {
        const next = await reader.read();
        if (abortError !== undefined) {
          return;
        }
        if (next.done) {
          streamController.close();
          settle();
          return;
        }
        streamController.enqueue(next.value);
      } catch (error) {
        if (abortError !== undefined) {
          return;
        }
        streamController.error(
          error instanceof Error
            ? error
            : new TypeError("S3 response stream failed."),
        );
        settle();
      }
    },
    async cancel(reason) {
      try {
        await cancelSource(reason);
      } finally {
        settle();
      }
    },
  });
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted === true) {
    abort();
  }
  return stream;
};
