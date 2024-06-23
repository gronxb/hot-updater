import { uploadS3 } from "@hot-updater/aws";
import { metro } from "@hot-updater/metro";

import { defineConfig } from "hot-updater";

export default defineConfig({
  updateServer: "",
  build: metro(),
  deploy: uploadS3({
    region: "ap-northeast-2",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    bucketName: process.env.AWS_S3_BUCKET_NAME!,
  }),
});
