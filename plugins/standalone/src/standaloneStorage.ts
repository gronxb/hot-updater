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
  uploadNativeBuild: (
    nativeBuildId: string,
    nativeBuildPath: string,
  ) => RouteConfig;
  deleteNativeBuild: (nativeBuildId: string) => RouteConfig;
  getNativeBuildDownloadUrl: (nativeBuildId: string) => RouteConfig;
}

const defaultRoutes: StorageRoutes = {
  uploadBundle: (bundleId: string, bundlePath: string) => ({
    path: "/uploadBundle",
  }),
  deleteBundle: (bundleId: string) => ({
    path: "/deleteBundle",
  }),
  uploadNativeBuild: (nativeBuildId: string, nativeBuildPath: string) => ({
    path: "/uploadNativeBuild",
  }),
  deleteNativeBuild: (nativeBuildId: string) => ({
    path: "/deleteNativeBuild",
  }),
  getNativeBuildDownloadUrl: (nativeBuildId: string) => ({
    path: "/getNativeBuildDownloadUrl",
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
      uploadNativeBuild: (nativeBuildId: string, nativeBuildPath: string) =>
        createRoute(
          defaultRoutes.uploadNativeBuild(nativeBuildId, nativeBuildPath),
          config.routes?.uploadNativeBuild?.(nativeBuildId, nativeBuildPath),
        ),
      deleteNativeBuild: (nativeBuildId: string) =>
        createRoute(
          defaultRoutes.deleteNativeBuild(nativeBuildId),
          config.routes?.deleteNativeBuild?.(nativeBuildId),
        ),
      getNativeBuildDownloadUrl: (nativeBuildId: string) =>
        createRoute(
          defaultRoutes.getNativeBuildDownloadUrl(nativeBuildId),
          config.routes?.getNativeBuildDownloadUrl?.(nativeBuildId),
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

      // Native build operations
      async uploadNativeBuild(nativeBuildId: string, nativeBuildPath: string) {
        const fileContent = await fs.readFile(nativeBuildPath);
        const contentType =
          mime.getType(nativeBuildPath) ?? "application/octet-stream";
        const filename = path.basename(nativeBuildPath);

        const { path: routePath, headers: routeHeaders } =
          routes.uploadNativeBuild(nativeBuildId, nativeBuildPath);

        const formData = new FormData();
        formData.append(
          "file",
          new Blob([fileContent], { type: contentType }),
          filename,
        );
        formData.append("nativeBuildId", nativeBuildId);

        const response = await fetch(`${config.baseUrl}${routePath}`, {
          method: "POST",
          headers: getHeaders(routeHeaders),
          body: formData,
        });

        if (!response.ok) {
          const error = `Failed to upload native build: ${response.statusText}`;
          console.error(`[uploadNativeBuild] ${error}`);
          throw new Error(error);
        }

        const result = (await response.json()) as {
          storageUri: string;
        };

        if (!result.storageUri) {
          const error =
            "Failed to upload native build - no storageUri in response";
          console.error(`[uploadNativeBuild] ${error}`);
          throw new Error(error);
        }

        hooks?.onStorageUploaded?.();

        return {
          storageUri: result.storageUri,
        };
      },

      async deleteNativeBuild(nativeBuildId: string) {
        const { path: routePath, headers: routeHeaders } =
          routes.deleteNativeBuild(nativeBuildId);
        const response = await fetch(`${config.baseUrl}${routePath}`, {
          method: "DELETE",
          headers: getHeaders(routeHeaders),
          body: JSON.stringify({ nativeBuildId }),
        });

        if (!response.ok) {
          const error = new Error(
            `Failed to delete native build: ${response.statusText}`,
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

      async getNativeBuildDownloadUrl(nativeBuildId: string) {
        const { path: routePath, headers: routeHeaders } =
          routes.getNativeBuildDownloadUrl(nativeBuildId);
        const response = await fetch(`${config.baseUrl}${routePath}`, {
          method: "GET",
          headers: getHeaders(routeHeaders),
        });

        if (!response.ok) {
          const error = new Error(
            `Failed to get native build download URL: ${response.statusText}`,
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
