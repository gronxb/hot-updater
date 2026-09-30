import { existsSync } from "node:fs";

import { s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { standaloneRepository } from "@hot-updater/standalone";
import { defineConfig } from "hot-updater";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

const adminToken = process.env.HOT_UPDATER_ADMIN_TOKEN;
if (!adminToken) throw new Error("HOT_UPDATER_ADMIN_TOKEN is required.");

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
  // A self-hosted server (examples-server/hono-mongodb), through its admin API:
  // it lists its own plugins, and the CLI uploads bundles to this storage.
  server: standaloneRepository({
    baseUrl: "http://localhost:3006/hot-updater/admin",
    commonHeaders: {
      Authorization: `Bearer ${adminToken}`,
    },
    storage: [
      s3Storage({
        region: "auto",
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
        bucketName: process.env.R2_BUCKET_NAME!,
      }),
    ],
  }),
  fingerprint: {
    debug: true,
  },
  updateStrategy: "appVersion",
});
