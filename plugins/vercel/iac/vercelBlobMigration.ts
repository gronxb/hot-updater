import { InitError } from "@hot-updater/cli-tools";
import { get, list, put } from "@vercel/blob";

/** Vercel's longest Blob store name. */
const MAX_STORE_NAME = 32;
const PRIVATE_SUFFIX = "-private";
const ONE_YEAR_IN_SECONDS = 31_536_000;
/** Above this, `put` uploads in parts, as vercelBlobStorage does. */
const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;

/**
 * The private store init moves a public store's bundles to: the public
 * store's name with `-private`, so a rerun finds the store an interrupted
 * run created.
 */
export const privateStoreNameFor = (publicName: string) => {
  const named = (suffix: string) =>
    `${publicName.slice(0, MAX_STORE_NAME - suffix.length)}${suffix}`;
  // A name that already ends in the suffix at full length maps to itself.
  const name = named(PRIVATE_SUFFIX);
  return name === publicName ? named(`${PRIVATE_SUFFIX}2`) : name;
};

/** Every object of a store, by pathname, with its size. */
const listObjects = async (token: string) => {
  const objects = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const page = await list({
      token,
      limit: 1000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const blob of page.blobs) objects.set(blob.pathname, blob.size);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor !== undefined);
  return objects;
};

/**
 * Copies every object of the public store `from` into the private store
 * `to` under the same pathname, so each storage URI keeps its key. An
 * object `to` already holds at the same size is skipped, so a rerun copies
 * only what an interrupted one did not. `from` is never changed.
 */
export const copyBlobStore = async ({
  from,
  to,
}: {
  readonly from: { readonly name: string; readonly token: string };
  readonly to: { readonly token: string };
}): Promise<{ readonly copied: number; readonly total: number }> => {
  const [source, copies] = await Promise.all([
    listObjects(from.token),
    listObjects(to.token),
  ]);
  let copied = 0;
  for (const [pathname, size] of source) {
    if (copies.get(pathname) === size) continue;
    const object = await get(pathname, {
      access: "public",
      token: from.token,
      useCache: false,
    });
    if (object?.statusCode !== 200) {
      throw new InitError(
        `Could not read ${pathname} from Blob store ${from.name}, so its bundles were not moved. Rerun init to continue.`,
      );
    }
    await put(pathname, object.stream, {
      access: "private",
      token: to.token,
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: ONE_YEAR_IN_SECONDS,
      contentType: object.blob.contentType,
      multipart: size > MULTIPART_THRESHOLD_BYTES,
    });
    copied += 1;
  }
  return { copied, total: source.size };
};
