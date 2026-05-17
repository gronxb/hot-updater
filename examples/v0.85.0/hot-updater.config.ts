import { s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import {
  standaloneRepository,
  standaloneStorage,
} from "@hot-updater/standalone";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

const standaloneStorageBaseUrl =
  process.env.HOT_UPDATER_STANDALONE_STORAGE_BASE_URL;
const managementAuthToken =
  process.env.HOT_UPDATER_AUTH_TOKEN?.trim() ||
  (process.env.HOT_UPDATER_E2E_PLATFORM ? "hot-updater-e2e-token" : undefined);

if (process.env.HOT_UPDATER_E2E_DEBUG_AUTH === "1") {
  console.error("[hot-updater-config] management auth", {
    hasToken: Boolean(managementAuthToken),
    tokenLength: managementAuthToken?.length ?? 0,
  });
}

export default defineConfig({
  nativeBuild: {
    android: {
      debugApk: {
        packageName: "com.hotupdaterexample",
        aab: false,
        variant: "Debug",
      },
      releaseApk: {
        packageName: "com.hotupdaterexample",
        aab: false,
      },
    },
    ios: {
      debug: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Debug",
        installPods: false,
        simulator: true,
      },
      release: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Release",
        installPods: true,
      },
    },
  },

  build: bare({ enableHermes: true }),
  storage: standaloneStorageBaseUrl
    ? standaloneStorage({
        baseUrl: standaloneStorageBaseUrl.replace(/\/+$/, ""),
      })
    : s3Storage({
        region: "auto",
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
        bucketName: process.env.R2_BUCKET_NAME!,
      }),
  database: standaloneRepository({
    baseUrl: "http://localhost:3007/hot-updater",
    ...(managementAuthToken
      ? {
          commonHeaders: {
            Authorization: `Bearer ${managementAuthToken}`,
          },
        }
      : {}),
  }),
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
