import { createBsdiffPatch } from "./internal/bsdiff.js";
import { type Bytes, type BytesLike, toUint8Array } from "./internal/bytes.js";

/** Creates an engine-neutral ENDSLEY/BSDIFF43 patch for arbitrary bytes. */
export async function bsdiff(base: BytesLike, next: BytesLike): Promise<Bytes> {
  return createBsdiffPatch(toUint8Array(base), toUint8Array(next));
}
