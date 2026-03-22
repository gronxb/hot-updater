import { verifyJwtSignedUrl } from "@hot-updater/js";
import { createHotUpdater } from "@hot-updater/server";
import { d1WorkerDatabase } from "../../src/cloudflareWorkerDatabase";
import { r2WorkerStorage } from "../../src/cloudflareWorkerStorage";
import {
  type CloudflareWorkerEnv,
  createCloudflareWorkerApp,
  HOT_UPDATER_BASE_PATH,
} from "./runtimeApp";

const hotUpdaterCache = new Map<string, ReturnType<typeof createHotUpdater>>();

const getHotUpdater = (env: CloudflareWorkerEnv, requestUrl: string) => {
  const publicBaseUrl = new URL(requestUrl).origin;
  const cached = hotUpdaterCache.get(publicBaseUrl);

  if (cached) {
    return cached;
  }

  const hotUpdater = createHotUpdater({
    database: d1WorkerDatabase({
      db: env.DB,
    }),
    storages: [
      r2WorkerStorage({
        jwtSecret: env.JWT_SECRET,
        publicBaseUrl,
      }),
    ],
    basePath: HOT_UPDATER_BASE_PATH,
    routes: {
      updateCheck: true,
      bundles: false,
    },
  });

  hotUpdaterCache.set(publicBaseUrl, hotUpdater);
  return hotUpdater;
};

const app = createCloudflareWorkerApp({
  getHotUpdater,
  verifySignedUrlImpl: verifyJwtSignedUrl,
});

export default app;
