import type { createEngine } from "@hot-updater/plugin-core";

/** A field no release of Hot Updater compiles, as a later release may add one. */
export const LATER_RELEASE_CATALOG_FIELD = "laterReleaseField";

const sha256 = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
};

/**
 * Rewrites a scope's stored catalog as a later release would compile it: a
 * field this release does not know on each release descriptor, with the
 * payload's hash and size to match. Returns the payload it wrote.
 */
export const writeCatalogFromLaterRelease = async (
  core: ReturnType<typeof createEngine>["core"],
  scopeKey: string,
): Promise<string> =>
  core.transaction(async (tx) => {
    const row = await tx.findOne("release_catalogs", { scope_key: scopeKey });
    if (row === null) throw new Error(`No catalog for ${scopeKey}.`);
    const parsed = JSON.parse(row.payload) as {
      releaseDescriptors: Record<string, unknown>[];
    };
    const payload = canonical({
      ...parsed,
      releaseDescriptors: parsed.releaseDescriptors.map((descriptor) => ({
        ...descriptor,
        [LATER_RELEASE_CATALOG_FIELD]: `for ${String(descriptor.releaseId)}`,
      })),
    });
    tx.update("release_catalogs", row, {
      payload,
      catalog_hash: await sha256(payload),
      byte_size: new TextEncoder().encode(payload).byteLength,
    });
    return payload;
  });
