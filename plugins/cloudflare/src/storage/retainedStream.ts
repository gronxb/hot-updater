export const retainR2ClientThroughStream = (
  source: ReadableStream<Uint8Array>,
  release: () => void,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  let settled = false;
  const settle = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
    release();
  };
  const abort = (): void => {
    void reader.cancel().finally(settle);
  };
  signal?.addEventListener("abort", abort, { once: true });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          settle();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(
          error instanceof Error
            ? error
            : new TypeError("Cloudflare R2 response stream failed."),
        );
        settle();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle();
      }
    },
  });
};
