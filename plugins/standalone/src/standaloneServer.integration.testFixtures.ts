import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import {
  createBlobDatabasePlugin,
  createDatabaseClient,
} from "@hot-updater/plugin-core";
import { createHotUpdater, type HotUpdaterAPI } from "@hot-updater/server";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

import { standaloneRepository } from "./index";

const store: Record<string, string> = {};

export const baseUrl = "http://localhost:3000";
export const server = setupServer();

export const createInMemoryBlobDatabase = (values: Record<string, string>) =>
  createBlobDatabasePlugin({
    name: "blob-test",
    plugin: () => ({
      apiBasePath: "/api/check-update",
      listObjects: async (prefix: string) =>
        Object.keys(values).filter((key) => key.startsWith(prefix)),
      loadObject: async (key: string) => {
        const value = values[key];
        return value === undefined ? null : JSON.parse(value);
      },
      uploadObject: async (key: string, data: unknown) => {
        values[key] = JSON.stringify(data);
      },
      compareAndSwapObject: async (key, expected, data) => {
        const current =
          values[key] === undefined ? null : JSON.parse(values[key]);
        if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
        values[key] = JSON.stringify(data);
        return true;
      },
      invalidatePaths: async () => {},
    }),
  });

export const api: HotUpdaterAPI = createHotUpdater({
  database: createInMemoryBlobDatabase(store),
  basePath: "/hot-updater",
  coreRoutes: {
    updateCheck: true,
    bundles: { access: { kind: "public" } },
  },
});

export const createTestBundle = (overrides?: Partial<Bundle>): Bundle => ({
  id: NIL_UUID,
  platform: "ios",
  channel: "production",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "test-hash",
  gitCommitHash: null,
  message: null,
  targetAppVersion: "*",
  storageUri: "test://storage",
  fingerprintHash: null,
  ...overrides,
});

export const createStandaloneClient = (base = `${baseUrl}/hot-updater`) =>
  createDatabaseClient(standaloneRepository({ baseUrl: base }));

export const startServer = (): void => {
  server.listen({ onUnhandledRequest: "error" });
  server.use(
    http.all(`${baseUrl}/hot-updater/*`, async ({ request }) => {
      const response = await api.handler(request);
      return new HttpResponse(await response.text(), {
        status: response.status,
        headers: response.headers,
      });
    }),
  );
};

export const resetServer = (): void => {
  for (const key of Object.keys(store)) Reflect.deleteProperty(store, key);
};

export const stopServer = (): void => {
  server.close();
};
