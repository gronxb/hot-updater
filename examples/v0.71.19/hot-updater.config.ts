import { s3Database, s3Storage } from "@hot-updater/aws";
import { metro } from "@hot-updater/metro";

import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({
  override: true,
});

export default defineConfig({
  build: metro(),
  storage: s3Storage(
    {
      region: "ap-northeast-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
      bucketName: process.env.AWS_S3_BUCKET_NAME!,
    },
    {
      onStorageUploaded: async () => {
        console.log("Storage Uploaded");
      },
    },
  ),
  database: s3Database(
    {
      region: "ap-northeast-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
      bucketName: process.env.AWS_S3_BUCKET_NAME!,
    },
    {
      onDatabaseUpdated: async () => {
        console.log("Database Updated");
      },
    },
  ),
});
