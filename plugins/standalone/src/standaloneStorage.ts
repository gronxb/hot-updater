import path from "path";
import type {
  BasePluginArgs,
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";
import fs from "fs/promises";
import mime from "mime";
import type { RouteConfig } from "./standaloneRepository";

export interface StorageRoutes {
  uploadBundle: (bundleId: string, bundlePath: string) => RouteConfig;
  deleteBundle: (bundleId: string) => RouteConfig;
}

const defaultRoutes: StorageRoutes = {
  uploadBundle: (bundleId: string, bundlePath: string) => ({
    path: "/uploadBundle",
  }),
  deleteBundle: (bundleId: string) => ({
    path: "/deleteBundle",
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
    };

    const getHeaders = (routeHeaders?: Record<string, string>) => ({
      ...config.commonHeaders,
      ...routeHeaders,
    });

    return {
      name: "standaloneStorage",
      async deleteBundle(bundleId: string) {
        const { path: routePath, headers: routeHeaders } =
          routes.deleteBundle(bundleId);
        const response = await fetch(`${config.baseUrl}${routePath}`, {
          method: "POST",
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

        return bundleId;
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
          bucketName: string;
          key: string;
        };

        if (!result.bucketName || !result.key) {
          const error =
            "Failed to upload bundle - no bucketName or key in response";
          console.error(`[uploadBundle] ${error}`);
          throw new Error(error);
        }

        hooks?.onStorageUploaded?.();

        return {
          bucketName: result.bucketName,
          key: result.key,
        };
      },
    };
  };
