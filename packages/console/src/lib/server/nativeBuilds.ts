import {
  type CompiledReleaseCatalog,
  type HotUpdaterCoreApi,
  type KeysetInput,
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

export interface NativeBuildListInput extends KeysetPageInput {
  /** Only the builds that embed this channel ID. */
  readonly channelId?: string;
}

export type NativeBuildListResult = KeysetPage<NativeBuildRow>;

/**
 * One page of native builds, newest first: one read of the registry's ID
 * index, or of its channel index for one channel's builds.
 */
export function listNativeBuilds(
  core: Pick<HotUpdaterCoreApi, "listNativeBuilds">,
  { channelId, ...page }: NativeBuildListInput,
): Promise<NativeBuildListResult> {
  return keysetPage(
    (input) =>
      core.listNativeBuilds({
        ...input,
        ...(channelId === undefined ? {} : { channelId }),
      }),
    ({ id }) => id,
    page,
  );
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
  /**
   * The newest build of the build's scope, which new deploys take their
   * patch base from: this build, or the build that supersedes it.
   */
  readonly newestInScope: NativeBuildRow | null;
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
 * Everything a native build's page shows, in five reads whatever the
 * build: the build, then its built-in bundle, its scope's newest build, its
 * scope's catalog, and one page of patches from it. Null for an unknown ID.
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
  const [builtIn, newestInScope, catalog, patches] = await Promise.all([
    core.getBundle(build.min_bundle_id),
    core.findNativeBuild(nativeBuildScope(build)),
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
