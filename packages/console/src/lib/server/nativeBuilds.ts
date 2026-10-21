import type {
  HotUpdaterCoreApi,
  NativeBuildRow,
  StorageAdapter,
} from "@hot-updater/plugin-core";

export interface NativeBuildListInput {
  /** Builds older than this id: the next page. */
  readonly before?: string;
  /** Builds newer than this id: the previous page. */
  readonly after?: string;
  readonly limit: number;
}

export interface NativeBuildListResult {
  /** Newest first. */
  readonly data: readonly NativeBuildRow[];
  /** `before` of the next page, when there may be older builds. */
  readonly next?: string;
  /** `after` of the previous page, when there may be newer builds. */
  readonly previous?: string;
}

/**
 * One page of native builds, newest first: one read of the registry's ID
 * index. `next` is set for a full page, so the last page may lead to an
 * empty one.
 */
export async function listNativeBuilds(
  core: Pick<HotUpdaterCoreApi, "listNativeBuilds">,
  { before, after, limit }: NativeBuildListInput,
): Promise<NativeBuildListResult> {
  const data =
    after === undefined
      ? await core.listNativeBuilds({
          order: "desc",
          limit,
          ...(before === undefined ? {} : { after: before }),
        })
      : (await core.listNativeBuilds({ order: "asc", after, limit })).reverse();
  const first = data[0]?.id;
  const last = data.at(-1)?.id;
  const full = data.length === limit;
  return {
    data,
    ...(last !== undefined && (after !== undefined || full)
      ? { next: last }
      : {}),
    ...(first !== undefined && (after === undefined ? before : full)
      ? { previous: first }
      : {}),
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
  if (build === null) return null;
  const storageUri = build.artifact_storage_uri;
  const adapter = storageFor(storage, storageUri);
  if (adapter?.getDownloadUrl !== undefined) {
    return (await adapter.getDownloadUrl({ storageUri })).url;
  }
  return adapter === undefined && isPublicUrl(storageUri) ? storageUri : null;
}

/**
 * Downloads a native build's artifact: a redirect to the storage's download
 * URL, or the object streamed through the console when the storage gives
 * no URL. The redirect is resolved on each request, so the console's link
 * never expires.
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
  if (adapter?.getDownloadUrl !== undefined) {
    const { url } = await adapter.getDownloadUrl({ storageUri });
    return new Response(null, {
      headers: { "cache-control": "private, no-store", location: url },
      status: 302,
    });
  }
  if (adapter?.get !== undefined) {
    const { response } = await adapter.get({ storageUri });
    if (!response) {
      return new Response("Storage object not found", { status: 404 });
    }
    const fileName = decodeURIComponent(storageUri.split("/").at(-1) ?? "");
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    headers.set(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  if (adapter === undefined && isPublicUrl(storageUri)) {
    return Response.redirect(storageUri, 302);
  }
  return new Response(
    `No storage adapter for protocol: ${protocolOf(storageUri)}`,
    { status: 503 },
  );
}
