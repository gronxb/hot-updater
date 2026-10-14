import { createHash } from "crypto";

/**
 * An archive served the way a network change leaves a download: the first
 * response promises every byte, sends half of them, and loses the connection.
 * A request for the rest (`Range: bytes=<offset>-`) gets a 206 from the same
 * bytes, as a storage origin answers a resumed download.
 */
export type ArchiveInterruption = {
  readonly body: Uint8Array;
  readonly etag: string;
  interruptions: number;
  resumes: number;
};

export type ArchiveInterruptionResponse = {
  readonly response: Response;
  readonly sentBytes: number;
};

// A validator lets a client resume: URLSession sends it back in If-Range.
const LAST_MODIFIED = "Thu, 01 Jan 2026 00:00:00 GMT";
// How long the connection stays open after the first half is written, so the
// bytes reach the client before the socket is destroyed.
const CONNECTION_LOSS_DELAY_MS = 300;

export function createArchiveInterruption(
  body: Uint8Array,
): ArchiveInterruption {
  return {
    body,
    etag: `"${createHash("sha256").update(body).digest("hex")}"`,
    interruptions: 0,
    resumes: 0,
  };
}

function resumableHeaders(entry: ArchiveInterruption) {
  return {
    "accept-ranges": "bytes",
    "content-type": "application/octet-stream",
    etag: entry.etag,
    "last-modified": LAST_MODIFIED,
  };
}

/**
 * The first half of the archive under a Content-Length of all of it. The
 * stream then errors, and the Node server destroys the socket mid-body.
 */
export function interruptArchive(
  entry: ArchiveInterruption,
): ArchiveInterruptionResponse {
  entry.interruptions += 1;
  const sentBytes = Math.max(1, Math.floor(entry.body.byteLength / 2));
  const head = entry.body.subarray(0, sentBytes);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
      setTimeout(() => {
        controller.error(new Error("Injected E2E archive interruption"));
      }, CONNECTION_LOSS_DELAY_MS);
    },
  });
  return {
    response: new Response(body, {
      headers: {
        ...resumableHeaders(entry),
        "content-length": String(entry.body.byteLength),
      },
      status: 200,
    }),
    sentBytes,
  };
}

/**
 * The rest of an interrupted archive for a `Range: bytes=<offset>-` request
 * whose If-Range, if any, still names it, or null for any other request.
 */
export function resumeArchive(
  entry: ArchiveInterruption,
  request: Request,
): ArchiveInterruptionResponse | null {
  const range = /^bytes=(\d+)-$/.exec(
    request.headers.get("range")?.trim() ?? "",
  );
  const ifRange = request.headers.get("if-range");
  if (
    !range ||
    (ifRange !== null && ifRange !== entry.etag && ifRange !== LAST_MODIFIED)
  ) {
    return null;
  }
  const total = entry.body.byteLength;
  const start = Number(range[1]);
  if (start >= total) {
    return {
      response: new Response(null, {
        headers: { "content-range": `bytes */${total}` },
        status: 416,
      }),
      sentBytes: 0,
    };
  }
  entry.resumes += 1;
  const rest = entry.body.subarray(start);
  return {
    response: new Response(rest, {
      headers: {
        ...resumableHeaders(entry),
        "content-length": String(rest.byteLength),
        "content-range": `bytes ${start}-${total - 1}/${total}`,
      },
      status: 206,
    }),
    sentBytes: rest.byteLength,
  };
}
