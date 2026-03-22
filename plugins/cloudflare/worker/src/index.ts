import { verifyJwtSignedUrl } from "@hot-updater/js";
import { createHotUpdater } from "@hot-updater/server";
import { cloudflareWorkerDatabase } from "../../src/cloudflareWorkerDatabase";
import { cloudflareWorkerStorage } from "../../src/cloudflareWorkerStorage";
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
    database: cloudflareWorkerDatabase({
      db: env.DB,
    }),
    storages: [
      cloudflareWorkerStorage({
        jwtSecret: env.JWT_SECRET,
        publicBaseUrl,
      }),
    ],
    basePath: HOT_UPDATER_BASE_PATH,
    features: {
      updateCheckOnly: true,
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
