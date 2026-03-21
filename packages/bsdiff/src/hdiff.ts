import { HdiffError } from "./errors.js";
import { createBsdiffPatch } from "./internal/bsdiff.js";
import { type Bytes, type BytesLike, toUint8Array } from "./internal/bytes.js";
import { validateExecutionHbc } from "./internal/hermes-validate.js";

export async function hdiff(base: BytesLike, next: BytesLike): Promise<Bytes> {
  const baseBytes = toUint8Array(base);
  const nextBytes = toUint8Array(next);

  const baseMeta = await validateExecutionHbc(baseBytes);
  const nextMeta = await validateExecutionHbc(nextBytes);

  if (baseMeta.version !== nextMeta.version) {
    throw new HdiffError(
      "BYTECODE_VERSION_MISMATCH",
      `HBC version mismatch: base=${baseMeta.version}, next=${nextMeta.version}`,
    );
  }

  return await createBsdiffPatch(baseBytes, nextBytes);
}
