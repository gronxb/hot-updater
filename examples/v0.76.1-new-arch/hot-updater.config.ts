import { metro } from "@hot-updater/metro";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
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
  storage: supabaseStorage(
    {
      supabaseUrl: process.env.SUPABASE_URL!,
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
      bucketName: process.env.SUPABASE_BUCKET_NAME!,
    },
    {
      transformFileUrl: (key) => {
        return `${process.env.SUPABASE_PUBLIC_URL!}/${key}`;
      },
    },
  ),
  database: supabaseDatabase({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
  }),
});
