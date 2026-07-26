import { StoragePluginError } from "@hot-updater/plugin-core/storage";

import { mapFirebaseError } from "./error";

const abortedError = (): StoragePluginError =>
  new StoragePluginError("aborted", "Firebase Storage operation was aborted.");

export const throwIfAborted = async (
  signal: AbortSignal | undefined,
  body?: ReadableStream<Uint8Array>,
): Promise<void> => {
  if (signal?.aborted !== true) {
    return;
  }
  await body?.cancel().then(undefined, () => undefined);
  throw abortedError();
};

export const wrapFirebaseStream = (
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  settle: () => Promise<void>,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  let settled: Promise<void> | undefined;
  let abortHandler: (() => void) | undefined;

  const finish = (): Promise<void> => {
    signal?.removeEventListener("abort", abortHandler ?? finish);
    settled ??= settle();
    return settled;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      abortHandler = () => {
        const error = abortedError();
        controller.error(error);
        void reader.cancel(error).then(finish, finish);
      };
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (signal?.aborted === true) {
        abortHandler();
      }
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          await finish();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        if (error instanceof Error) {
          controller.error(mapFirebaseError(error));
          await finish();
          return;
        }
        controller.error(mapFirebaseError(error));
        await finish();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).then(undefined, () => undefined);
      await finish();
    },
  });
};
