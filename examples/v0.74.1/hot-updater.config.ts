import { existsSync } from "node:fs";

import { s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { standaloneRepository } from "@hot-updater/standalone";
import { defineConfig, secret } from "hot-updater";
import { insights } from "hot-updater/plugins";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

const adminToken = secret("HOT_UPDATER_ADMIN_TOKEN");

export default defineConfig({
  nativeBuild: {
    android: {
      releaseApk: {
        packageName: "com.hotupdaterexample",
        aab: false,
      },
    },
  },

  build: bare({ enableHermes: true }),
  storage: s3Storage({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: secret("R2_ACCESS_KEY_ID"),
      secretAccessKey: secret("R2_SECRET_ACCESS_KEY"),
    },
    bucketName: process.env.R2_BUCKET_NAME!,
  }),
  database: standaloneRepository({
    baseUrl: "http://localhost:3006/hot-updater/admin",
    commonHeaders: {
      Authorization: async () => `Bearer ${await adminToken()}`,
    },
  }),
  // The plugins its server, examples-server/hono-mongodb, runs.
  plugins: [insights()],
  fingerprint: {
    debug: true,
  },
  /* E2E_AUTO_PATCH_CONFIG_START */
  patch: {
    enabled: true,
    maxBaseBundles: 2,
  },
  /* E2E_AUTO_PATCH_CONFIG_END */
  updateStrategy: "appVersion",
  signing: {
    enabled: true,
    privateKeyPath: "./keys/private-key.pem",
  },
});
