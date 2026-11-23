// How many parts a spread body is sent in.
const SPREAD_PARTS = 20;

/**
 * `body` sent in equal parts over `durationMs`, as a slow network delivers a
 * download: the first part at once, the last one `durationMs` later. The
 * stream stops sending when the client goes away.
 */
export function spreadDownloadBody(
  body: Uint8Array,
  durationMs: number,
): ReadableStream<Uint8Array> {
  const parts = Math.max(1, Math.min(SPREAD_PARTS, body.byteLength));
  const partSize = Math.ceil(body.byteLength / parts);
  const interval = parts > 1 ? durationMs / (parts - 1) : 0;
  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const sendNext = () => {
        const end = Math.min(body.byteLength, sent + partSize);
        if (end > sent) controller.enqueue(body.slice(sent, end));
        sent = end;
        if (sent >= body.byteLength) {
          controller.close();
          return;
        }
        timer = setTimeout(sendNext, interval);
      };
      if (body.byteLength === 0) {
        controller.close();
        return;
      }
      sendNext();
    },
    cancel() {
      clearTimeout(timer);
    },
  });
}
