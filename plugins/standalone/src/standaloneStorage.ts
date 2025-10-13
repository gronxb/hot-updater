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
  uploadBundle: (bundleId: string, bundlePath: string) => RouteConfig;
  deleteBundle: (bundleId: string) => RouteConfig;
  getDownloadUrl: (storageUri: string) => RouteConfig;
}

const defaultRoutes: StorageRoutes = {
  uploadBundle: (_bundleId: string, _bundlePath: string) => ({
    path: "/uploadBundle",
  }),
  deleteBundle: (_bundleId: string) => ({
    path: "/deleteBundle",
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
      uploadBundle: (bundleId: string, bundlePath: string) =>
        createRoute(
          defaultRoutes.uploadBundle(bundleId, bundlePath),
          config.routes?.uploadBundle?.(bundleId, bundlePath),
        ),
      deleteBundle: (bundleId: string) =>
        createRoute(
          defaultRoutes.deleteBundle(bundleId),
          config.routes?.deleteBundle?.(bundleId),
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
      async deleteBundle(bundleId: string) {
        const { path: routePath, headers: routeHeaders } =
          routes.deleteBundle(bundleId);
        const response = await fetch(`${config.baseUrl}${routePath}`, {
          method: "DELETE",
          headers: getHeaders(routeHeaders),
          body: JSON.stringify({ bundleId }),
        });

        if (!response.ok) {
          const error = new Error(
            `Failed to delete bundle: ${response.statusText}`,
          );
          console.error(error);
          throw error;
        }
        const result = (await response.json()) as {
          storageUri: string;
        };
        return {
          storageUri: result.storageUri,
        };
      },
      async uploadBundle(bundleId: string, bundlePath: string) {
        const fileContent = await fs.readFile(bundlePath);
        const contentType =
          mime.getType(bundlePath) ?? "application/octet-stream";
        const filename = path.basename(bundlePath);

        const { path: routePath, headers: routeHeaders } = routes.uploadBundle(
          bundleId,
          bundlePath,
        );

        const formData = new FormData();
        formData.append(
          "file",
          new Blob([fileContent], { type: contentType }),
          filename,
        );
        formData.append("bundleId", bundleId);

        const response = await fetch(`${config.baseUrl}${routePath}`, {
          method: "POST",
          headers: getHeaders(routeHeaders),
          body: formData,
        });

        if (!response.ok) {
          const error = `Failed to upload bundle: ${response.statusText}`;
          console.error(`[uploadBundle] ${error}`);
          throw new Error(error);
        }

        const result = (await response.json()) as {
          storageUri: string;
        };

        if (!result.storageUri) {
          const error = "Failed to upload bundle - no storageUri in response";
          console.error(`[uploadBundle] ${error}`);
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
