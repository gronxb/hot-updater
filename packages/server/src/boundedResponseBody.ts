export class ResponseBodyTooLargeError extends Error {
  readonly name = "ResponseBodyTooLargeError";

  constructor(readonly maxBytes: number) {
    super(`Storage response exceeds the ${maxBytes} byte limit`);
  }
}

const parseContentLength = (response: Response): number | null => {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export const readBoundedResponseBytes = async (
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> => {
  const contentLength = parseContentLength(response);
  if (contentLength !== null && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new ResponseBodyTooLargeError(maxBytes);
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
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
