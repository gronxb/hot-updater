import { createHotUpdater } from "@hot-updater/server";
import {
  plugins,
  supabaseDatabase,
  supabaseStorage,
} from "@hot-updater/supabase";

import { sample } from "./samplePlugin";

/**
 * The Hot Updater server: its database, storage, and plugins.
 * hot-updater.config.ts points the CLI and the console here.
 */
export const hotUpdater = createHotUpdater({
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
  }),
  storage: [
    supabaseStorage({
      supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
      supabaseServiceRoleKey:
        process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
      bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
    }),
  ],
  plugins: [...plugins, sample()],
});
