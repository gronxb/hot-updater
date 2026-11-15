import {
  createStorageAdapter,
  createStorageKeyBuilder,
  createStorageUri,
  parseStorageUri,
  type StorageAdapterWith,
  type StorageObject,
} from "@hot-updater/plugin-core";

import {
  createGithubClient,
  githubError,
  type GithubRepositoryOptions,
} from "./githubApi";
import { createGithubJsonFile } from "./githubJsonFile";

export interface GithubReleaseStorageConfig extends GithubRepositoryOptions {
  /** A folder every key is stored below. */
  readonly basePath?: string;
  /**
   * The JSON file that maps each key to its release asset. Defaults to
   * `hot-updater/storage.json`.
   */
  readonly indexPath?: string;
  /** The branch that holds the index. Defaults to the repository's default branch. */
  readonly branch?: string;
  /**
   * How long a read may answer from the index this process last fetched, in
   * milliseconds. 0, the default, revalidates every read with GitHub.
   */
  readonly cacheTtlMs?: number;
}

type GithubReleaseStorageOperations =
  | "put"
  | "get"
  | "getDownloadUrl"
  | "exists"
  | "delete"
  | "listObjects"
  | "deleteObjects";

interface ObjectEntry {
  /** The release asset that holds the bytes; null for an empty object, which GitHub refuses to store. */
  readonly asset: number | null;
  /** The release the asset belongs to. */
  readonly release: number | null;
  readonly size: number;
  readonly contentType: string;
  readonly updatedAt: number;
}

interface StorageIndex {
  /** How many assets each storage release holds, by release id. */
  readonly releases: { readonly [id: string]: number };
  /** Every object by its key, base path included. */
  readonly objects: { readonly [key: string]: ObjectEntry };
}

const PROTOCOL = "github-release";
export const DEFAULT_STORAGE_INDEX_PATH = "hot-updater/storage.json";
/** GitHub allows 1,000 assets per release; the rest is room for uploads in flight. */
const RELEASE_CAPACITY = 900;

const parseIndex = (data: unknown): StorageIndex => {
  const index = data as Partial<StorageIndex> | null;
  if (
    typeof index?.releases !== "object" ||
    index.releases === null ||
    typeof index.objects !== "object" ||
    index.objects === null
  ) {
    throw new Error("The Hot Updater storage index is malformed.");
  }
  return index as StorageIndex;
};

/** `index` with `key` set to `entry`, or removed when `entry` is undefined. */
const withObject = (
  index: StorageIndex,
  key: string,
  entry: ObjectEntry | undefined,
): StorageIndex => {
  const previous = index.objects[key];
  const releases = { ...index.releases };
  if (previous?.release != null) {
    const left = (releases[previous.release] ?? 1) - 1;
    releases[previous.release] = Math.max(left, 0);
  }
  if (entry?.release != null) {
    releases[entry.release] = (releases[entry.release] ?? 0) + 1;
  }
  const objects = { ...index.objects };
  if (entry === undefined) delete objects[key];
  else objects[key] = entry;
  return { releases, objects };
};

/**
 * Stores objects as release assets of a GitHub repository, which may be
 * private. GitHub names an asset by a numeric id, so a JSON index in the
 * repository maps each key to its asset. A download URL is the short-lived
 * signed URL GitHub redirects an authorized asset request to.
 */
export const githubReleaseStorage = (
  config: GithubReleaseStorageConfig,
): StorageAdapterWith<GithubReleaseStorageOperations> => {
  const client = createGithubClient(config);
  const objectKey = createStorageKeyBuilder(config.basePath);
  const basePrefix = objectKey();
  const index = createGithubJsonFile<StorageIndex>({
    client,
    path: config.indexPath ?? DEFAULT_STORAGE_INDEX_PATH,
    branch: config.branch,
    cacheTtlMs: config.cacheTtlMs,
    empty: () => ({ releases: {}, objects: {} }),
    parse: parseIndex,
  });

  const uriOf = (key: string) =>
    createStorageUri({ protocol: PROTOCOL, bucket: client.bucket, key });
  const keyOf = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, PROTOCOL);
    if (parsed.bucket !== client.bucket) {
      throw new Error(
        `Expected repository "${client.bucket}", got "${parsed.bucket}".`,
      );
    }
    return parsed.key;
  };
  const relativeKey = (key: string) =>
    basePrefix === "" ? key : key.slice(basePrefix.length + 1);

  /** The release uploads go to, and how many assets this process has sent it. */
  let open: { readonly id: number; used: number } | undefined;
  let choosing: Promise<unknown> = Promise.resolve();

  const createRelease = async (): Promise<number> => {
    const response = await client.request(client.repoUrl("/releases"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tag_name: `hot-updater-storage-${crypto.randomUUID().slice(0, 8)}`,
        name: "Hot Updater storage",
        body: "Bundle artifacts that Hot Updater manages. Do not edit.",
        prerelease: true,
        make_latest: "false",
      }),
    });
    if (!response.ok) throw await githubError(response, "create a release");
    return ((await response.json()) as { id: number }).id;
  };

  /** One upload's release: the open one while it has room, else another. */
  const chooseRelease = (): Promise<number> => {
    const chosen = choosing.then(async () => {
      if (open === undefined || open.used >= RELEASE_CAPACITY) {
        const { releases } = await index.read();
        const known = Object.entries(releases).find(
          ([id, assets]) =>
            assets < RELEASE_CAPACITY && Number(id) !== open?.id,
        );
        open =
          known === undefined
            ? { id: await createRelease(), used: 0 }
            : { id: Number(known[0]), used: known[1] };
      }
      open.used += 1;
      return open.id;
    });
    choosing = chosen.catch(() => undefined);
    return chosen;
  };

  const deleteAsset = async (asset: number): Promise<void> => {
    const response = await client.request(
      client.repoUrl(`/releases/assets/${asset}`),
      { method: "DELETE" },
    );
    await response.body?.cancel();
    // An asset already gone is the state a delete asks for.
    if (!response.ok && response.status !== 404) {
      throw await githubError(response, `delete asset ${asset}`);
    }
  };

  /** The signed URL GitHub redirects an asset download to; null when the asset is gone. */
  const signedUrl = async (asset: number): Promise<string | null> => {
    const url = client.repoUrl(`/releases/assets/${asset}`);
    const response = await client.request(url, {
      headers: { accept: "application/octet-stream" },
      redirect: "manual",
    });
    const location = response.headers.get("location");
    const redirected = response.status >= 300 && response.status < 400;
    // A runtime that cannot stop at a redirect, such as React Native,
    // follows it and reports where it ended.
    const followed = response.ok && response.url !== "" && response.url !== url;
    if (!(redirected && location) && !followed && response.status !== 404) {
      throw await githubError(response, `resolve the URL of asset ${asset}`);
    }
    await response.body?.cancel();
    if (response.status === 404) return null;
    return redirected ? location : response.url;
  };

  const entryOf = async (storageUri: string) =>
    (await index.read()).objects[keyOf(storageUri)];

  return createStorageAdapter({
    name: "githubReleaseStorage",
    protocol: PROTOCOL,

    async put({ key, body, contentType }) {
      const storedKey = objectKey(key);
      const storageUri = uriOf(storedKey);
      // GitHub needs the length up front, and a body that fails must leave
      // no object, so the body is read whole before anything is sent.
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      let asset: number | null = null;
      let release: number | null = null;
      if (bytes.byteLength > 0) {
        release = await chooseRelease();
        // The index maps the key to the asset; a name only has to be unique.
        const response = await client.request(
          client.uploadUrl(
            `/releases/${release}/assets?name=${crypto.randomUUID()}`,
          ),
          {
            method: "POST",
            headers: { "content-type": contentType },
            body: bytes,
          },
        );
        if (!response.ok) throw await githubError(response, `upload ${key}`);
        asset = ((await response.json()) as { id: number }).id;
      }
      const entry: ObjectEntry = {
        asset,
        release,
        size: bytes.byteLength,
        contentType,
        updatedAt: Date.now(),
      };
      let previous: ObjectEntry | undefined;
      try {
        previous = await index.update((current) => ({
          next: withObject(current, storedKey, entry),
          result: current.objects[storedKey],
        }));
      } catch (error) {
        if (asset !== null) await deleteAsset(asset);
        throw error;
      }
      if (previous?.asset != null) await deleteAsset(previous.asset);
      return { storageUri };
    },

    async get({ storageUri }) {
      const entry = await entryOf(storageUri);
      if (entry === undefined) return { response: null };
      const headers = {
        "content-type": entry.contentType,
        "content-length": String(entry.size),
      };
      if (entry.asset === null) {
        return { response: new Response(new Uint8Array(), { headers }) };
      }
      const url = await signedUrl(entry.asset);
      if (url === null) return { response: null };
      const download = await client.fetch(url);
      if (download.status === 404) {
        await download.body?.cancel();
        return { response: null };
      }
      if (!download.ok) throw await githubError(download, "download an asset");
      return { response: new Response(download.body, { headers }) };
    },

    async getDownloadUrl({ storageUri }) {
      const entry = await entryOf(storageUri);
      if (entry === undefined) {
        throw new Error(`No object is stored at ${storageUri}.`);
      }
      if (entry.asset === null) {
        throw new Error(
          `${storageUri} is empty, and GitHub serves no download for an empty release asset.`,
        );
      }
      const url = await signedUrl(entry.asset);
      if (url === null) {
        throw new Error(`The release asset of ${storageUri} is missing.`);
      }
      return { url };
    },

    async exists({ storageUri }) {
      return { exists: (await entryOf(storageUri)) !== undefined };
    },

    async delete({ storageUri }) {
      const key = keyOf(storageUri);
      const previous = await index.update((current) =>
        current.objects[key] === undefined
          ? { result: undefined }
          : {
              next: withObject(current, key, undefined),
              result: current.objects[key],
            },
      );
      if (previous?.asset != null) await deleteAsset(previous.asset);
      return { deleted: true };
    },

    async listObjects(prefix) {
      const folder = objectKey(prefix ?? "");
      const { objects } = await index.read();
      return Object.entries(objects)
        .filter(([key]) => folder === "" || key.startsWith(`${folder}/`))
        .map(
          ([key, entry]): StorageObject => ({
            key: relativeKey(key),
            storageUri: uriOf(key),
            size: entry.size,
            lastModifiedAt: new Date(entry.updatedAt),
          }),
        );
    },

    async deleteObjects(keys) {
      const storedKeys = keys.map((key) => objectKey(key));
      const removed = await index.update((current) => {
        const found = storedKeys.flatMap((key) => current.objects[key] ?? []);
        return found.length === 0
          ? { result: found }
          : {
              next: storedKeys.reduce(
                (next, key) => withObject(next, key, undefined),
                current,
              ),
              result: found,
            };
      });
      for (const { asset } of removed) {
        if (asset !== null) await deleteAsset(asset);
      }
    },
  });
};
