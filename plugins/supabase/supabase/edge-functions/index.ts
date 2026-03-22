import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createHotUpdater } from "npm:@hot-updater/server";
import {
  supabaseEdgeFunctionDatabase,
  supabaseEdgeFunctionStorage,
} from "npm:@hot-updater/supabase";
import { createSupabaseEdgeFunctionApp } from "../../src/createSupabaseEdgeFunctionApp";

declare global {
  var HotUpdater: {
    FUNCTION_NAME: string;
  };
}

const functionName = HotUpdater.FUNCTION_NAME;
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const functionBasePath = `/${functionName}`;
const hotUpdaterBasePath = "/api/check-update";

const hotUpdater = createHotUpdater({
  database: supabaseEdgeFunctionDatabase({
    supabaseUrl,
    supabaseServiceRoleKey,
  }),
  storages: [
    supabaseEdgeFunctionStorage({
      supabaseUrl,
      supabaseServiceRoleKey,
    }),
  ],
  basePath: hotUpdaterBasePath,
  routes: {
    updateCheck: true,
    bundles: false,
  },
});

const app = createSupabaseEdgeFunctionApp({
  functionBasePath,
  getHotUpdater: () => hotUpdater,
});

Deno.serve(app.fetch);
