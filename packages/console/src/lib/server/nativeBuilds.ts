import {
  type CompiledReleaseCatalog,
  type HotUpdaterCoreApi,
  type KeysetInput,
  nativeBuildDistribution,
  type NativeBuildRow,
  projectCompiledCatalog,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import type { ReleaseCatalogDescriptor } from "@hot-updater/protocol";

import {
  nativeBuildCatalogScopeKey,
  nativeBuildChannel,
  nativeBuildScope,
} from "../native-builds";
import { type FoldedPage, foldedPage, readFold } from "./foldedPage";

export interface KeysetPageInput {
  /** Rows older than this key: the next page. */
  readonly before?: string;
  /** Rows newer than this key: the previous page. */
  readonly after?: string;
  readonly limit: number;
}

export interface KeysetPage<T> {
  /** Newest first. */
  readonly data: readonly T[];
  /** `before` of the next page, when there may be older rows. */
  readonly next?: string;
  /** `after` of the previous page, when there may be newer rows. */
  readonly previous?: string;
}

/**
 * One page newest first, from one keyset read: newest first for the next
 * page, oldest first (then reversed) for the previous one. `next` is set
 * for a full page, so the last page may lead to an empty one.
 */
async function keysetPage<T>(
  read: (input: KeysetInput) => Promise<readonly T[]>,
  keyOf: (row: T) => string,
  { before, after, limit }: KeysetPageInput,
): Promise<KeysetPage<T>> {
  const data =
    after === undefined
      ? await read({
          order: "desc",
          limit,
          ...(before === undefined ? {} : { after: before }),
        })
      : [...(await read({ order: "asc", after, limit }))].reverse();
  const first = data[0];
  const last = data.at(-1);
  const full = data.length === limit;
  return {
    data,
    ...(last !== undefined && (after !== undefined || full)
      ? { next: keyOf(last) }
      : {}),
    ...(first !== undefined && (after === undefined ? before : full)
      ? { previous: keyOf(first) }
      : {}),
  };
}

/** A patch from a build's built-in bundle: the bundle it updates to, and its size. */
export interface NativeBuildPatch {
  readonly bundleId: string;
  readonly byteSize: number;
}

export type NativeBuildPatchPage = KeysetPage<NativeBuildPatch>;

/** How many patches one page of a build's patches lists. */
export const NATIVE_BUILD_PATCH_PAGE_SIZE = 20;

/**
 * One page of the patches from a built-in bundle, newest target first: one
 * read of the patches index. The patch rows carry what the page shows, so
 * no bundle is read.
 */
export function listNativeBuildPatches(
  core: Pick<HotUpdaterCoreApi, "listPatchesFromBase">,
  minBundleId: string,
  page: KeysetPageInput,
): Promise<NativeBuildPatchPage> {
  return keysetPage(
    async (input) =>
      (await core.listPatchesFromBase(minBundleId, input)).map(
        ({ bundle_id, byte_size }) => ({
          bundleId: bundle_id,
          byteSize: byte_size,
        }),
      ),
    ({ bundleId }) => bundleId,
    page,
  );
}

export interface NativeBuildDetail {
  readonly build: NativeBuildRow;
  /** The channel the build embeds. */
  readonly channel: string;
  /** The Release Catalog scope whose releases an install is offered. */
  readonly catalogScopeKey: string;
  /** How many bundles patch from the built-in bundle, or null when its row is gone. */
  readonly builtInBundle: { readonly childCount: number } | null;
  /** The newest build of the build's scope: this build or a later one. */
  readonly newestInScope: NativeBuildRow | null;
  /**
   * The build marked as the store build in the scope. New deploys patch from it,
   * or with no mark from the newest build.
   */
  readonly storeBuildInScope: NativeBuildRow | null;
  /**
   * The releases the update check serves an install of this build now,
   * newest first: the scope's catalog, at the build's app version, down to
   * the built-in bundle the device floors at.
   */
  readonly servedNow: readonly ReleaseCatalogDescriptor[];
  /** The newest page of patches from the built-in bundle. */
  readonly patches: NativeBuildPatchPage;
}

/**
 * Everything a native build's page shows, in six reads at most: the build,
 * then its built-in bundle, its scope's newest build and its mark, which a
 * marked build's own row answers, its scope's catalog, and one page of patches
 * from it. Null for an unknown ID.
 */
export async function getNativeBuildDetail(
  core: Pick<
    HotUpdaterCoreApi,
    | "getNativeBuild"
    | "getBundle"
    | "findNativeBuild"
    | "getReleaseCatalogRow"
    | "listPatchesFromBase"
  >,
  id: string,
): Promise<NativeBuildDetail | null> {
  const build = await core.getNativeBuild(id);
  if (build === null) return null;
  const catalogScopeKey = nativeBuildCatalogScopeKey(build);
  const scope = nativeBuildScope(build);
  const [builtIn, newestInScope, storeBuildInScope, catalog, patches] =
    await Promise.all([
      core.getBundle(build.min_bundle_id),
      core.findNativeBuild(scope),
      build.is_store_build
        ? build
        : core.findNativeBuild(scope, { storeBuild: true }),
      core.getReleaseCatalogRow(catalogScopeKey),
      listNativeBuildPatches(core, build.min_bundle_id, {
        limit: NATIVE_BUILD_PATCH_PAGE_SIZE,
      }),
    ]);
  const servedNow =
    catalog === null || catalog.is_tombstone
      ? []
      : projectCompiledCatalog(
          JSON.parse(catalog.payload) as CompiledReleaseCatalog,
          build.app_version ?? undefined,
        ).filter(
          // The floor the device applies: a release older than the build's
          // built-in bundle is older than what the binary ships.
          ({ bundleId }) =>
            bundleId !== null && bundleId >= build.min_bundle_id,
        );
  return {
    build,
    channel: nativeBuildChannel(build),
    catalogScopeKey,
    builtInBundle: builtIn === null ? null : { childCount: builtIn.childCount },
    newestInScope,
    storeBuildInScope,
    servedNow,
    patches,
  };
}

const protocolOf = (storageUri: string) =>
  new URL(storageUri).protocol.replace(":", "");

/** The storage that holds `storageUri`, by its protocol. */
const storageFor = (storage: StorageAdapter, storageUri: string) =>
  storage.protocol === protocolOf(storageUri) ? storage : undefined;

/** A public URL no storage owns, which is its own download URL. */
const isPublicUrl = (storageUri: string) =>
  ["http", "https"].includes(protocolOf(storageUri));

/**
 * The URL a build's artifact downloads from without the console's sign-in: the
 * storage's download URL, which may expire. Null when the storage gives none.
 */
export async function nativeBuildArtifactUrl(
  build: Pick<NativeBuildRow, "artifact_storage_uri">,
  storage: StorageAdapter,
): Promise<string | null> {
  const storageUri = build.artifact_storage_uri;
  const adapter = storageFor(storage, storageUri);
  if (adapter?.getDownloadUrl !== undefined) {
    return (await adapter.getDownloadUrl({ storageUri })).url;
  }
  return adapter === undefined && isPublicUrl(storageUri) ? storageUri : null;
}

/**
 * The URL a phone downloads a native build's artifact from, without the
 * console's sign-in: the storage's download URL, which may expire. Null
 * when the storage gives none, or the build is gone.
 */
export async function resolveNativeBuildDownloadUrl(
  id: string,
  {
    core,
    storage,
  }: {
    readonly core: Pick<HotUpdaterCoreApi, "getNativeBuild">;
    readonly storage: StorageAdapter;
  },
): Promise<string | null> {
  const build = await core.getNativeBuild(id);
  return build === null ? null : nativeBuildArtifactUrl(build, storage);
}

/**
 * What Android's browser offers to install. An upload stores it, so a redirect
 * to the storage serves it too; a streamed download sets it, for a storage
 * whose `get` keeps no type.
 */
const APK_CONTENT_TYPE = "application/vnd.android.package-archive";

const noStoreRedirect = (url: string) =>
  new Response(null, {
    headers: { "cache-control": "private, no-store", location: url },
    status: 302,
  });

/**
 * The URL a browser or script can fetch the object from by itself, or null
 * when the storage gives none, or gives one only it can read. When the
 * storage can't serve the object any other way, its failure stands.
 */
const publicDownloadUrl = async (
  adapter: StorageAdapter,
  storageUri: string,
): Promise<string | null> => {
  if (adapter.getDownloadUrl === undefined) return null;
  try {
    const { url } = await adapter.getDownloadUrl({ storageUri });
    return /^https?:\/\//iu.test(url) ? url : null;
  } catch (error) {
    if (adapter.get === undefined) throw error;
    console.warn(
      `Streaming a native build through the console: ${adapter.name} gave no download URL.`,
      error,
    );
    return null;
  }
};

/**
 * Downloads a native build's artifact: a redirect to the storage's download
 * URL, or, when the storage gives no URL a browser can fetch, the object
 * streamed through the console, whose host then serves every byte. The
 * redirect is resolved on each request, so the console's link never expires.
 */
export async function downloadNativeBuild(
  id: string,
  {
    core,
    storage,
  }: {
    readonly core: Pick<HotUpdaterCoreApi, "getNativeBuild">;
    readonly storage: StorageAdapter;
  },
): Promise<Response> {
  const build = await core.getNativeBuild(id);
  if (build === null) return new Response("Build not found", { status: 404 });

  const storageUri = build.artifact_storage_uri;
  const adapter = storageFor(storage, storageUri);
  const url = adapter && (await publicDownloadUrl(adapter, storageUri));
  if (url) return noStoreRedirect(url);
  if (adapter?.get !== undefined) {
    const { response } = await adapter.get({ storageUri });
    if (!response) {
      return new Response("Storage object not found", { status: 404 });
    }
    const fileName = decodeURIComponent(storageUri.split("/").at(-1) ?? "");
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    if (build.artifact_kind === "apk") {
      headers.set("content-type", APK_CONTENT_TYPE);
    }
    headers.set(
      "content-disposition",
      // `filename` for the clients that don't read `filename*`, such as curl.
      `attachment; filename="${fileName.replace(/[^\w.-]/gu, "_")}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  if (adapter === undefined && isPublicUrl(storageUri)) {
    return noStoreRedirect(storageUri);
  }
  return new Response(
    `No storage adapter for protocol: ${protocolOf(storageUri)}`,
    { status: 503 },
  );
}

/** A page of native builds that leads with each distribution path's newest. */
export type NativeBuildFoldedPage = FoldedPage<NativeBuildRow>;

/**
 * The newest build on each distribution path of `builds`, by the path's
 * index: one read per path, each path read once per `paths` map.
 */
const newestOnPaths = async (
  core: Pick<HotUpdaterCoreApi, "findNativeBuildOnPath">,
  builds: readonly NativeBuildRow[],
  paths: Map<string, Promise<NativeBuildRow | null>>,
): Promise<Map<string, NativeBuildRow | null>> => {
  const keyOf = (build: NativeBuildRow) =>
    JSON.stringify([
      build.channel_id,
      build.platform,
      build.is_sandbox,
      nativeBuildDistribution(build),
    ]);
  for (const build of builds) {
    const key = keyOf(build);
    if (!paths.has(key)) {
      paths.set(
        key,
        core.findNativeBuildOnPath({
          platform: build.platform,
          channel: nativeBuildChannel(build),
          sandbox: build.is_sandbox,
          distribution: nativeBuildDistribution(build),
        }),
      );
    }
  }
  return new Map(
    await Promise.all(
      builds.map(
        async (build) => [build.id, await paths.get(keyOf(build))!] as const,
      ),
    ),
  );
};

/** Whether no build on `build`'s path is newer, or it is the store build. */
const isNewestOnPath = (build: NativeBuildRow, newest: NativeBuildRow | null) =>
  build.is_store_build || newest === null || newest.id === build.id;

/**
 * One page of native builds, newest first, that leads with the newest build
 * of each distribution path, and the store build: every other build folds
 * into the runs between them. It reads the registry's ID index, or its
 * channel index, a chunk at a time (at most `FOLDED_PAGE_READ_BUDGET` rows),
 * and each distribution path's newest once.
 */
export function listNativeBuildFolds(
  core: Pick<HotUpdaterCoreApi, "listNativeBuilds" | "findNativeBuildOnPath">,
  {
    channelId,
    before,
    after,
  }: {
    readonly channelId?: string;
    readonly before?: string;
    readonly after?: string;
  },
): Promise<NativeBuildFoldedPage> {
  const paths = new Map<string, Promise<NativeBuildRow | null>>();
  return foldedPage({
    read: (input) =>
      core.listNativeBuilds({
        ...input,
        ...(channelId === undefined ? {} : { channelId }),
      }),
    classify: async (builds) => {
      const newest = await newestOnPaths(core, builds, paths);
      return new Set(
        builds
          .filter((build) => isNewestOnPath(build, newest.get(build.id)!))
          .map(({ id }) => id),
      );
    },
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  });
}

/** One chunk of a fold's builds, each with the newer build on its path. */
export interface NativeBuildFoldChunk {
  readonly rows: readonly NativeBuildRow[];
  /** The newest build on each row's path, by row ID, where it is newer. */
  readonly newer: Readonly<Record<string, NativeBuildRow>>;
  readonly next?: string;
}

/**
 * One chunk of a fold's builds, as `listNativeBuildFolds` folded them: the
 * builds under `from` down to `to`, and each one's newer build, one read of
 * each path.
 */
export async function readNativeBuildFold(
  core: Pick<HotUpdaterCoreApi, "listNativeBuilds" | "findNativeBuildOnPath">,
  {
    channelId,
    ...fold
  }: {
    readonly channelId?: string;
    readonly from?: string;
    readonly to: string;
    readonly after?: string;
  },
): Promise<NativeBuildFoldChunk> {
  const chunk = await readFold({
    read: (input) =>
      core.listNativeBuilds({
        ...input,
        ...(channelId === undefined ? {} : { channelId }),
      }),
    ...fold,
  });
  const newest = await newestOnPaths(core, chunk.rows, new Map());
  return {
    ...chunk,
    newer: Object.fromEntries(
      chunk.rows.flatMap((build) => {
        const top = newest.get(build.id)!;
        return isNewestOnPath(build, top) ? [] : [[build.id, top!]];
      }),
    ),
  };
}
