import type {
  DatabaseClient,
  StoragePluginWith,
} from "@hot-updater/plugin-core";

interface DownloadBundleDependencies {
  readonly databaseClient: DatabaseClient;
  readonly storagePlugin?: StoragePluginWith<"get">;
}

export const downloadBundle = async (
  bundleId: string,
  { databaseClient, storagePlugin }: DownloadBundleDependencies,
): Promise<Response> => {
  const bundle = await databaseClient.getBundleById(bundleId);
  if (!bundle) return new Response("Bundle not found", { status: 404 });

  const storageUri = bundle.storageUri;
  if (!storageUri) {
    return new Response("Bundle has no storage URI", { status: 404 });
  }

  const protocol = new URL(storageUri).protocol.replace(":", "");
  if (protocol === "http" || protocol === "https") {
    return Response.redirect(storageUri, 302);
  }
  if (!storagePlugin || storagePlugin.protocol !== protocol) {
    return new Response(`No storage plugin for protocol: ${protocol}`, {
      status: 503,
    });
  }

  const response = await storagePlugin.get(storageUri);
  if (!response)
    return new Response("Storage object not found", { status: 404 });

  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("content-disposition", "attachment");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};
