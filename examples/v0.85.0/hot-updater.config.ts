import { s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import {
  standaloneRepository,
  standaloneStorage,
} from "@hot-updater/standalone";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

import { supportsAnalyticsForE2E } from "../../e2e/detox/analyticsCapability";

config({
  path: process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH ?? ".env.hotupdater",
});

const standaloneStorageBaseUrl =
  process.env.HOT_UPDATER_STANDALONE_STORAGE_BASE_URL;
const standaloneRepositoryBaseUrl =
  process.env.HOT_UPDATER_CONTROL_BASE_URL ??
  process.env.HOT_UPDATER_APP_BASE_URL;
const localS3StorageEndpoint = process.env.AWS_S3_ENDPOINT;
const providerNamespace = process.env.HOT_UPDATER_E2E_PROVIDER_NAMESPACE;
const managementAuthToken = process.env.HOT_UPDATER_AUTH_TOKEN?.trim();
const managementHeaders = managementAuthToken
  ? { Authorization: `Bearer ${managementAuthToken}` }
  : undefined;

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

  build: bare({ enableHermes: true, resetCache: false }),
  storage: localS3StorageEndpoint
    ? s3Storage({
        region: process.env.AWS_REGION ?? "us-east-1",
        endpoint: localS3StorageEndpoint,
        credentials: {
          accessKeyId:
            process.env.AWS_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey:
            process.env.AWS_SECRET_ACCESS_KEY ??
            process.env.R2_SECRET_ACCESS_KEY!,
        },
        bucketName:
          process.env.AWS_S3_METADATA_BUCKET ?? process.env.R2_BUCKET_NAME!,
        basePath: providerNamespace,
        forcePathStyle: true,
      })
    : standaloneStorageBaseUrl
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
          basePath: providerNamespace,
        }),
  database: standaloneRepository({
    baseUrl: standaloneRepositoryBaseUrl ?? "http://localhost:3007/hot-updater",
    ...(supportsAnalyticsForE2E(
      process.env.HOT_UPDATER_E2E_SUPPORTS_ANALYTICS,
    )
      ? { supportsAnalytics: true }
      : {}),
    ...(managementHeaders ? { commonHeaders: managementHeaders } : {}),
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
