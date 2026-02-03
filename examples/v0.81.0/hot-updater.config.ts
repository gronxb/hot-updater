import { s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { standaloneRepository } from "@hot-updater/standalone";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

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
        simulator: false,
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
  storage: s3Storage({
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
  }),
  fingerprint: {
    debug: true,
  },
  updateStrategy: "appVersion",
  compressStrategy: "tar.br",
  signing: {
    enabled: true,
    privateKeyPath: "./keys/private-key.pem",
  },
});
