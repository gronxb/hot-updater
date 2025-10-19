import { s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { standaloneRepository } from "@hot-updater/standalone";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

export default defineConfig({
  nativeBuild: { android: { aab: false } },

  build: bare({ enableHermes: true }),
  storage: s3Storage({
    region: process.env.HOT_UPDATER_AWS_REGION!,
    credentials: {
      accessKeyId: process.env.HOT_UPDATER_AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.HOT_UPDATER_AWS_SECRET_ACCESS_KEY!,
    },
    bucketName: process.env.HOT_UPDATER_AWS_S3_BUCKET_NAME!,
  }),
  database: standaloneRepository({
    baseUrl:
      process.env.HOT_UPDATER_SERVER_URL ||
      "http://localhost:3000/hot-updater",
  }),
  fingerprint: {
    debug: true,
  },
  updateStrategy: "appVersion",
});
