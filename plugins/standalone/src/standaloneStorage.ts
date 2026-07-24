import fs from "fs/promises";
import path from "path";

import type {
  UniversalStoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";
import mime from "mime";

import type { RouteConfig } from "./standaloneRepository";
import { createStandaloneTransport } from "./standaloneTransport";

export interface StorageRoutes {
  readonly upload: (key: string, filePath: string) => RouteConfig;
  readonly delete: (storageUri: string) => RouteConfig;
  readonly readText: (storageUri: string) => RouteConfig;
  readonly getDownloadUrl: (storageUri: string) => RouteConfig;
}

const defaultRoutes: StorageRoutes = {
  upload: (_key: string, _filePath: string) => ({
    path: "/upload",
  }),
  delete: (_storageUri: string) => ({
    path: "/delete",
  }),
  readText: (_storageUri: string) => ({
    path: "/readText",
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
  readonly baseUrl: string;
  readonly commonHeaders?: Readonly<Record<string, string>>;
  readonly routes?: StorageRoutes;
}

export const standaloneStorage =
  (config: StandaloneStorageConfig, hooks?: StoragePluginHooks) =>
  (): UniversalStoragePlugin => {
    const transport = createStandaloneTransport(config);
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
      readText: (storageUri: string) =>
        createRoute(
          defaultRoutes.readText(storageUri),
          config.routes?.readText?.(storageUri),
        ),
      getDownloadUrl: (storageUri: string) =>
        createRoute(
          defaultRoutes.getDownloadUrl(storageUri),
          config.routes?.getDownloadUrl?.(storageUri),
        ),
    };

    return {
      name: "standaloneStorage",
      supportedProtocol: "http",
      profiles: {
        node: {
          async delete(storageUri: string) {
            const { path: routePath, headers: routeHeaders } =
              routes.delete(storageUri);
            const response = await transport.request(
              { path: routePath, headers: routeHeaders },
              {
                method: "DELETE",
                body: JSON.stringify({ storageUri }),
              },
            );

            if (!response.ok) {
              const error = new Error(
                `Failed to delete bundle with status ${response.status}.`,
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

            const response = await transport.request(
              { path: routePath, headers: routeHeaders },
              { method: "POST", body: formData },
            );

            if (!response.ok) {
              const error = `Failed to upload bundle with status ${response.status}.`;
              console.error(`[upload] ${error}`);
              throw new Error(error);
            }

            const result: unknown = await response.json();
            const storageUri =
              typeof result === "object" && result !== null
                ? Reflect.get(result, "storageUri")
                : undefined;
            if (typeof storageUri !== "string" || storageUri === "") {
              const error =
                "Failed to upload bundle - no storageUri in response";
              console.error(`[upload] ${error}`);
              throw new Error(error);
            }

            await hooks?.onStorageUploaded?.();

            return {
              storageUri,
            };
          },
          async exists(storageUri: string) {
            const { fileUrl } = await getDownloadUrl(storageUri);
            const response = await fetch(fileUrl, { method: "HEAD" });
            return response.ok;
          },
          async downloadFile(storageUri: string, filePath: string) {
            const { fileUrl } = await getDownloadUrl(storageUri);
            const response = await fetch(fileUrl);
            if (!response.ok) {
              throw new Error(
                `Failed to download bundle with status ${response.status}.`,
              );
            }

            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(
              filePath,
              new Uint8Array(await response.arrayBuffer()),
            );
          },
        },
        runtime: {
          async readText(storageUri: string) {
            const { path: routePath, headers: routeHeaders } =
              routes.readText(storageUri);
            const response = await transport.request(
              { path: routePath, headers: routeHeaders },
              {
                method: "POST",
                body: JSON.stringify({ storageUri }),
              },
            );
            if (!response.ok) {
              return null;
            }

            return response.text();
          },
          getDownloadUrl,
        },
      },
    };

    async function getDownloadUrl(storageUri: string) {
      const { path: routePath, headers: routeHeaders } =
        routes.getDownloadUrl(storageUri);
      const response = await transport.request(
        { path: routePath, headers: routeHeaders },
        {
          method: "POST",
          body: JSON.stringify({ storageUri }),
        },
      );

      if (!response.ok) {
        const error = new Error(
          `Failed to get download URL with status ${response.status}.`,
        );
        console.error(error);
        throw error;
      }
      const result: unknown = await response.json();
      const fileUrl =
        typeof result === "object" && result !== null
          ? Reflect.get(result, "fileUrl")
          : undefined;
      if (typeof fileUrl !== "string") {
        throw new Error("Failed to get download URL: invalid response");
      }
      return {
        fileUrl,
      };
    }
  };
