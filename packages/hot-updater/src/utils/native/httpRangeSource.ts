import type { ByteSource } from "@hot-updater/protocol/native-artifact";

const KiB = 1024;
const MiB = 1024 * KiB;
/**
 * What one request asks for at least: a zip entry's local header and, for
 * something the size of a profile, its data, so reading one takes one request.
 */
const READ_AHEAD_BYTES = 64 * KiB;
/** How many requests' bytes stay at hand: the archive's tail, and its entries. */
const KEPT_BLOCKS = 4;
/** The most one IPA's reading downloads: a directory and a few small files. */
const MAX_BYTES = 16 * MiB;
/** The most requests one IPA's reading makes, past a dozen extensions' profiles. */
const MAX_REQUESTS = 24;
const REQUEST_TIMEOUT_MS = 15_000;

/** Why a remote artifact can't be read in parts. */
export class RangeSourceError extends Error {
  override readonly name = "RangeSourceError";
}

/**
 * The bytes of `url` by HTTP Range requests, for reading an `.ipa`'s profiles
 * from storage without ever downloading the file. The Console keeps its own
 * copy, as each package implements this transport over its own runtime: a server that answers a Range request with the whole file (200) is
 * cut off at once, as is one that sends more than it was asked for. Reading
 * stops at `MAX_BYTES` and `MAX_REQUESTS`.
 */
export const httpRangeSource = ({
  url,
  size,
  fetch = globalThis.fetch,
}: {
  readonly url: string;
  /** The artifact's length, as its build's row records it. */
  readonly size: number;
  readonly fetch?: typeof globalThis.fetch;
}): ByteSource => {
  const blocks: { readonly start: number; readonly bytes: Uint8Array }[] = [];
  let requests = 0;
  let downloaded = 0;

  const request = async (start: number, end: number): Promise<Uint8Array> => {
    if (requests === MAX_REQUESTS) {
      throw new RangeSourceError(
        "Reading the artifact took too many requests.",
      );
    }
    const length = end - start;
    if (downloaded + length > MAX_BYTES) {
      throw new RangeSourceError(
        "Reading the artifact would download too much.",
      );
    }
    requests += 1;
    const response = await fetch(url, {
      headers: {
        range: `bytes=${start}-${end - 1}`,
        "accept-encoding": "identity",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const contentRange = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(
      response.headers.get("content-range") ?? "",
    );
    if (
      response.status !== 206 ||
      Number(contentRange?.[1]) !== start ||
      Number(contentRange?.[2]) !== end - 1 ||
      (contentRange?.[3] !== "*" && Number(contentRange?.[3]) !== size) ||
      response.body === null
    ) {
      await response.body?.cancel().catch(() => {});
      throw new RangeSourceError(
        `The storage answered ${response.status} to a Range request.`,
      );
    }
    const bytes = new Uint8Array(length);
    const reader = response.body.getReader();
    let written = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (written + value.byteLength > length) {
          throw new RangeSourceError(
            "The storage sent more than it was asked.",
          );
        }
        bytes.set(value, written);
        written += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (written !== length) {
      throw new RangeSourceError("The storage sent less than it was asked.");
    }
    downloaded += length;
    return bytes;
  };

  return {
    size,
    async read(offset, length) {
      const end = Math.min(size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      for (const block of blocks) {
        if (block.start <= offset && end <= block.start + block.bytes.length) {
          return block.bytes.subarray(offset - block.start, end - block.start);
        }
      }
      const blockEnd = Math.min(size, Math.max(end, offset + READ_AHEAD_BYTES));
      const bytes = await request(offset, blockEnd);
      blocks.push({ start: offset, bytes });
      // The first block is the archive's tail, which holds its directory.
      if (blocks.length > KEPT_BLOCKS) blocks.splice(1, 1);
      return bytes.subarray(0, end - offset);
    },
  };
};
