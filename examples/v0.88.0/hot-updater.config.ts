import { s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { insights, remoteConfig } from "@hot-updater/server/plugins";
import { standaloneRepository } from "@hot-updater/standalone";
import { defineConfig } from "hot-updater";

process.loadEnvFile(process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH ?? ".env.hotupdater");

export default defineConfig({
  build: bare({ enableHermes: true, resetCache: false }),
  storage: s3Storage({
    region: process.env.AWS_REGION!,
    endpoint: process.env.AWS_S3_ENDPOINT!,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    bucketName: process.env.AWS_S3_METADATA_BUCKET!,
    basePath: process.env.HOT_UPDATER_E2E_PROVIDER_NAMESPACE,
    forcePathStyle: true,
  }),
  database: standaloneRepository({
    baseUrl: process.env.HOT_UPDATER_CONTROL_BASE_URL! + "/admin",
    commonHeaders: { Authorization: "Bearer " + process.env.HOT_UPDATER_ADMIN_TOKEN! },
  }),
  plugins: [insights(), remoteConfig()],
  fingerprint: {
    debug: true,
    extraSources: {"ios":[],"android":[]},
  },
  /* E2E_AUTO_PATCH_CONFIG_START */
  /* E2E_AUTO_PATCH_CONFIG_END */
  updateStrategy: "appVersion",
  signing: { enabled: true, privateKeyPath: "./keys/private-key.pem" },
});
