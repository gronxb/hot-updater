import { fromSSO } from "@aws-sdk/credential-provider-sso";
import { dynamoDB, plugins, s3Storage } from "@hot-updater/aws";
import { createHotUpdater } from "@hot-updater/server";

import { sample } from "./samplePlugin";

const awsOptions = {
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};

/**
 * The Hot Updater server: its database, storage, and plugins.
 * hot-updater.config.ts points the CLI and the console here.
 */
export const hotUpdater = createHotUpdater({
  database: dynamoDB({
    ...awsOptions,
    tableName: process.env.HOT_UPDATER_DYNAMODB_TABLE_NAME!,
    cloudfrontDistributionId:
      process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  }),
  storage: [
    s3Storage({
      ...awsOptions,
      bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
    }),
  ],
  plugins: [...plugins, sample()],
});
