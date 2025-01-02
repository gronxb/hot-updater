import { s3Storage } from "@hot-updater/aws";
import { metro } from "@hot-updater/metro";
import { supabase } from "@hot-updater/supabase";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({
  override: true,
});

export default defineConfig({
  console: {
    gitUrl: "https://github.com/gronxb/hot-updater",
  },
  build: metro(),
  storage: s3Storage(
    {
      // supabase s3
      forcePathStyle: true,
      endpoint: process.env.AWS_ENDPOINT!,

      // common s3
      region: process.env.AWS_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
      bucketName: process.env.AWS_S3_BUCKET_NAME!,
    },
    {
      transformFileUrl: (key) => {
        return `${process.env.AWS_PUBLIC_URL!}/${key}`;
      },
    },
  ),
  database: supabase({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
  }),
});
