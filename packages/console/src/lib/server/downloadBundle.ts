import type {
  HotUpdaterCoreApi,
  StorageAdapter,
} from "@hot-updater/plugin-core";

interface DownloadBundleDependencies {
  readonly core: Pick<HotUpdaterCoreApi, "getBundle">;
  /** The server's storage, which reads the manifest of its protocol. */
  readonly storage: StorageAdapter | undefined;
}

export const downloadBundle = async (
  bundleId: string,
  { core, storage }: DownloadBundleDependencies,
): Promise<Response> => {
  const detail = await core.getBundle(bundleId);
  if (!detail) return new Response("Bundle not found", { status: 404 });

  const storageUri = detail.bundle.manifest_storage_uri;

  const protocol = new URL(storageUri).protocol.replace(":", "");
  const storageAdapter = storage?.protocol === protocol ? storage : undefined;
  if (storageAdapter?.get !== undefined) {
    const { response } = await storageAdapter.get({ storageUri });
    if (!response)
      return new Response("Storage object not found", { status: 404 });

    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-store");
    headers.set("content-disposition", 'attachment; filename="manifest.json"');
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }

  if (protocol !== "http" && protocol !== "https") {
    return new Response(`No storage adapter for protocol: ${protocol}`, {
      status: 503,
    });
  }

  return Response.redirect(storageUri, 302);
};
