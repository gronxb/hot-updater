import { s3Storage } from "@hot-updater/aws";
import { metro } from "@hot-updater/metro";
import { postgres } from "@hot-updater/postgres";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({
  override: true,
});

export default defineConfig({
  build: metro(),
  storage: s3Storage({
    endpoint: process.env.AWS_ENDPOINT!,
    region: process.env.AWS_REGION!,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    bucketName: process.env.AWS_S3_BUCKET_NAME!,
  }),
  database: postgres({
    host: process.env.POSTGRES_HOST!,
    port: Number(process.env.POSTGRES_PORT!),
    database: process.env.POSTGRES_DATABASE!,
    user: process.env.POSTGRES_USER!,
    password: process.env.POSTGRES_PASSWORD!,
  }),
});
