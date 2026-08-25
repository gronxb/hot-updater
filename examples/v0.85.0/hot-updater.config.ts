import { dynamoDB, s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { fromSSO } from "@aws-sdk/credential-provider-sso";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({
  path: process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH ?? ".env.hotupdater",
});

const awsOptions = {
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};

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
  storage: s3Storage({
    ...awsOptions,
    bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  }),
  database: dynamoDB({
    ...awsOptions,
    tableName: process.env.HOT_UPDATER_DYNAMODB_TABLE_NAME!,
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
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

  authorityId: "aws.reMLxCmkhy5IVoGMbgVXEHreq6A0k5gFU5G7BZ_jPWk",
});
