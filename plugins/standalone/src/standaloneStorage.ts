import {
  createStorageAdapter,
  parseStorageUri,
  type StorageDeleteInput,
  type StorageExistsInput,
  type StorageGetInput,
  type StorageObject,
  type StoragePutInput,
} from "@hot-updater/plugin-core";

/** A storage route: its path, and headers added to the common ones. */
export interface RouteConfig {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface StorageRoutes {
  put: (input: Omit<StoragePutInput, "body">) => RouteConfig;
  get: (input: StorageGetInput) => RouteConfig;
  exists: (input: StorageExistsInput) => RouteConfig;
  delete: (input: StorageDeleteInput) => RouteConfig;
  /** Lists objects for `hot-updater storage prune`. */
  listObjects: (input: { readonly prefix?: string }) => RouteConfig;
  /** Deletes exact keys for `hot-updater storage prune --yes`. */
  deleteObjects: (input: { readonly keys: readonly string[] }) => RouteConfig;
}

const defaultRoutes: StorageRoutes = {
  put: () => ({ path: "/upload" }),
  get: () => ({ path: "/get" }),
  exists: () => ({ path: "/exists" }),
  delete: () => ({ path: "/delete" }),
  listObjects: () => ({ path: "/list" }),
  deleteObjects: () => ({ path: "/delete-objects" }),
};

/** Keys sent in one `deleteObjects` request. */
const DELETE_BATCH_SIZE = 1000;

interface ListedObject {
  readonly key: string;
  readonly storageUri: string;
  readonly size: number;
  readonly lastModifiedAt?: string;
}

const createRoute = (
  defaultRoute: RouteConfig,
  customRoute?: Partial<RouteConfig>,
): RouteConfig => ({
  path: customRoute?.path ?? defaultRoute.path,
  headers: {
    ...defaultRoute.headers,
    ...customRoute?.headers,
  },
});

export interface StandaloneStorageConfig {
  baseUrl: string;
  /** Storage URI protocol owned by the remote implementation. */
  protocol: string;
  commonHeaders?: Record<string, string>;
  routes?: Partial<StorageRoutes>;
}

export const standaloneStorage = (config: StandaloneStorageConfig) => {
  const getHeaders = (routeHeaders?: Record<string, string>) => ({
    ...config.commonHeaders,
    ...routeHeaders,
  });

  const resolveRoute = <TArgs extends readonly unknown[]>(
    name: keyof StorageRoutes,
    args: TArgs,
  ) => {
    const fallback = defaultRoutes[name] as unknown as (
      ...args: TArgs
    ) => RouteConfig;
    const custom = config.routes?.[name] as
      | ((...args: TArgs) => RouteConfig)
      | undefined;
    return createRoute(fallback(...args), custom?.(...args));
  };

  const postJson = (
    path: string,
    headers: Readonly<Record<string, string>> | undefined,
    body: unknown,
  ) =>
    fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...getHeaders(headers) },
      body: JSON.stringify(body),
    });

  const requestStorageUri = async (
    routeName: "get" | "exists" | "delete",
    storageUri: string,
  ) => {
    parseStorageUri(storageUri, config.protocol);
    const { path, headers } = resolveRoute(routeName, [
      { storageUri },
    ] as const);
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: routeName === "delete" ? "DELETE" : "POST",
      headers: {
        "content-type": "application/json",
        ...getHeaders(headers),
      },
      body: JSON.stringify({ storageUri }),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Failed to ${routeName} storage object: ${response.statusText}`,
      );
    }
    return response;
  };

  return createStorageAdapter({
    name: "standaloneStorage",
    protocol: config.protocol,
    async put({ key, body, contentType, contentLength }) {
      const routeInput = { key, contentLength, contentType };
      const { path, headers } = resolveRoute("put", [routeInput] as const);
      const bytes = await new Response(body).arrayBuffer();
      if (contentLength !== undefined && bytes.byteLength !== contentLength) {
        throw new Error(
          `Storage upload length mismatch: expected ${contentLength}, got ${bytes.byteLength}`,
        );
      }
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([bytes], { type: contentType }),
        key.split("/").at(-1) ?? "object",
      );
      formData.append("key", key);
      const response = await fetch(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: getHeaders(headers),
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`Failed to upload bundle: ${response.statusText}`);
      }
      const result = (await response.json()) as { storageUri?: string };
      if (!result.storageUri) {
        throw new Error("Storage server returned an empty storage URI");
      }
      parseStorageUri(result.storageUri, config.protocol);
      return { storageUri: result.storageUri };
    },
    async get({ storageUri }) {
      const response = await requestStorageUri("get", storageUri);
      return { response: response.status === 404 ? null : response };
    },
    async exists({ storageUri }) {
      const response = await requestStorageUri("exists", storageUri);
      if (response.status === 404) return { exists: false };
      return {
        exists: ((await response.json()) as { exists: boolean }).exists,
      };
    },
    async delete({ storageUri }) {
      await requestStorageUri("delete", storageUri);
      return { deleted: true };
    },
    async listObjects(prefix?: string) {
      const { path, headers } = resolveRoute("listObjects", [
        { prefix },
      ] as const);
      const objects: StorageObject[] = [];
      let cursor: string | undefined;
      do {
        const response = await postJson(path, headers, { prefix, cursor });
        if (response.status === 404) {
          throw new Error(
            `The storage service has no ${path} route, which storage prune needs.`,
          );
        }
        if (!response.ok) {
          throw new Error(
            `Failed to list storage objects: ${response.statusText}`,
          );
        }
        const page = (await response.json()) as {
          objects: ListedObject[];
          cursor?: string;
        };
        for (const object of page.objects) {
          parseStorageUri(object.storageUri, config.protocol);
          objects.push({
            key: object.key,
            storageUri: object.storageUri,
            size: object.size,
            ...(object.lastModifiedAt === undefined
              ? {}
              : { lastModifiedAt: new Date(object.lastModifiedAt) }),
          });
        }
        cursor = page.cursor;
      } while (cursor !== undefined);
      return objects;
    },
    async deleteObjects(keys) {
      for (let offset = 0; offset < keys.length; offset += DELETE_BATCH_SIZE) {
        const batch = keys.slice(offset, offset + DELETE_BATCH_SIZE);
        const { path, headers } = resolveRoute("deleteObjects", [
          { keys: batch },
        ] as const);
        const response = await postJson(path, headers, { keys: batch });
        if (!response.ok) {
          throw new Error(
            `Failed to delete storage objects: ${response.statusText}`,
          );
        }
      }
    },
  });
};
