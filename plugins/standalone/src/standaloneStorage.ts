import type {
  BasePluginArgs,
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";
import fs from "fs/promises";
import mime from "mime";
import path from "path";
import type { RouteConfig } from "./standaloneRepository";

export interface StorageRoutes {
  upload: (key: string, filePath: string) => RouteConfig;
  delete: (storageUri: string) => RouteConfig;
  getDownloadUrl: (storageUri: string) => RouteConfig;
}

const defaultRoutes: StorageRoutes = {
  upload: (_key: string, _filePath: string) => ({
    path: "/upload",
  }),
  delete: (_storageUri: string) => ({
    path: "/delete",
  }),
  getDownloadUrl: (_storageUri: string) => ({
    path: "/getDownloadUrl",
  }),
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
  routes?: StorageRoutes;
}

export const standaloneStorage =
  (config: StandaloneStorageConfig, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {
    const routes: StorageRoutes = {
      upload: (key: string, filePath: string) =>
        createRoute(
          defaultRoutes.upload(key, filePath),
          config.routes?.upload?.(key, filePath),
        ),
      delete: (storageUri: string) =>
        createRoute(
          defaultRoutes.delete(storageUri),
          config.routes?.delete?.(storageUri),
        ),
      getDownloadUrl: (storageUri: string) =>
        createRoute(
          defaultRoutes.getDownloadUrl(storageUri),
          config.routes?.getDownloadUrl?.(storageUri),
        ),
    };

    const getHeaders = (routeHeaders?: Record<string, string>) => ({
      ...config.commonHeaders,
      ...routeHeaders,
    });

    return {
      name: "standaloneStorage",
      supportedProtocol: "http",
      async delete(storageUri: string) {
        const { path: routePath, headers: routeHeaders } =
          routes.delete(storageUri);
        const response = await fetch(`${config.baseUrl}${routePath}`, {
          method: "DELETE",
          headers: getHeaders(routeHeaders),
          body: JSON.stringify({ storageUri }),
        });

        if (!response.ok) {
          const error = new Error(
            `Failed to delete bundle: ${response.statusText}`,
          );
          console.error(error);
          throw error;
        }
      },
      async upload(key: string, filePath: string) {
        const fileContent = await fs.readFile(filePath);
        const contentType =
          mime.getType(filePath) ?? "application/octet-stream";
        const filename = path.basename(filePath);

        const { path: routePath, headers: routeHeaders } = routes.upload(
          key,
          filePath,
        );

        const formData = new FormData();
        formData.append(
          "file",
          new Blob([fileContent], { type: contentType }),
          filename,
        );
        formData.append("key", key);

        const response = await fetch(`${config.baseUrl}${routePath}`, {
          method: "POST",
          headers: getHeaders(routeHeaders),
          body: formData,
        });

        if (!response.ok) {
          const error = `Failed to upload bundle: ${response.statusText}`;
          console.error(`[upload] ${error}`);
          throw new Error(error);
        }

        const result = (await response.json()) as {
          storageUri: string;
        };

        if (!result.storageUri) {
          const error = "Failed to upload bundle - no storageUri in response";
          console.error(`[upload] ${error}`);
          throw new Error(error);
        }

        hooks?.onStorageUploaded?.();

        return {
          storageUri: result.storageUri,
        };
      },
      async getDownloadUrl(storageUri: string) {
        const { path: routePath, headers: routeHeaders } =
          routes.getDownloadUrl(storageUri);
        const response = await fetch(`${config.baseUrl}${routePath}`, {
          method: "POST",
          headers: getHeaders(routeHeaders),
          body: JSON.stringify({ storageUri }),
        });

        if (!response.ok) {
          const error = new Error(
            `Failed to get download URL: ${response.statusText}`,
          );
          console.error(error);
          throw error;
        }
        const result = (await response.json()) as {
          fileUrl: string;
        };
        return {
          fileUrl: result.fileUrl,
        };
      },
    };
  };
