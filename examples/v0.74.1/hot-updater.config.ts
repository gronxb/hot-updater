import { bare } from "@hot-updater/bare";
import { r2Storage } from "@hot-updater/cloudflare";
import { standaloneRepository } from "@hot-updater/standalone";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

const managementToken = process.env.HOT_UPDATER_AUTH_TOKEN;
if (!managementToken) {
  throw new Error("HOT_UPDATER_AUTH_TOKEN is required.");
}

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
  storage: r2Storage({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    bucketName: process.env.R2_BUCKET_NAME!,
  }),
  database: standaloneRepository({
    baseUrl: "http://localhost:3006/hot-updater",
    commonHeaders: {
      Authorization: `Bearer ${managementToken}`,
    },
  }),
  fingerprint: {
    debug: true,
  },
  updateStrategy: "appVersion",
  compressStrategy: "tar.br",
});
