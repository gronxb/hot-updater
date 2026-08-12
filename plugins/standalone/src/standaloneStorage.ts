import {
  createStoragePlugin,
  type StoragePutInput,
} from "@hot-updater/plugin-core";

import type { RouteConfig } from "./standaloneRepository";

export interface StorageRoutes {
  put: (input: Pick<StoragePutInput, "key" | "contentType">) => RouteConfig;
  get: (storageUri: string) => RouteConfig;
  exists: (storageUri: string) => RouteConfig;
  delete: (storageUri: string) => RouteConfig;
}

const defaultRoutes: StorageRoutes = {
  put: () => ({ path: "/upload" }),
  get: () => ({ path: "/get" }),
  exists: () => ({ path: "/exists" }),
  delete: () => ({ path: "/delete" }),
};

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

  const requestStorageUri = async (
    routeName: "get" | "exists" | "delete",
    storageUri: string,
  ) => {
    const { path, headers } = resolveRoute(routeName, [storageUri] as const);
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

  return createStoragePlugin({
    name: "standaloneStorage",
    protocol: "http",
    async put({ key, body, contentType }) {
      const routeInput = { key, contentType };
      const { path, headers } = resolveRoute("put", [routeInput] as const);
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([body], { type: contentType }),
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
      return { storageUri: result.storageUri };
    },
    async get(storageUri) {
      const response = await requestStorageUri("get", storageUri);
      if (response.status === 404) return null;
      return response;
    },
    async exists(storageUri) {
      const response = await requestStorageUri("exists", storageUri);
      if (response.status === 404) return false;
      return ((await response.json()) as { exists: boolean }).exists;
    },
    async delete(storageUri) {
      await requestStorageUri("delete", storageUri);
    },
  });
};
