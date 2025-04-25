import { bare } from "@hot-updater/bare";
import { withSentry } from "@hot-updater/sentry-plugin";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { defineConfig } from "hot-updater";
import "dotenv/config";

export default defineConfig({
  build: withSentry(
    bare({
      enableHermes: false,
      sourcemap: true, // sentry will upload sourcemaps to sentry
    }),
    {
      org: "hot-updater",
      project: "react-native",
      // Auth tokens can be obtained from https://sentry.io/orgredirect/organizations/:orgslug/settings/auth-tokens/
      authToken: process.env.SENTRY_AUTH_TOKEN!,
    },
  ),
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
  }),
});
