import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createHotUpdater } from "@hot-updater/server";
import {
  supabaseEdgeFunctionDatabase,
  supabaseEdgeFunctionStorage,
} from "@hot-updater/supabase";
import { Hono } from "npm:hono";

declare global {
  var HotUpdater: {
    FUNCTION_NAME: string;
  };
}

const functionName = HotUpdater.FUNCTION_NAME;
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseDbUrl =
  Deno.env.get("SUPABASE_DB_URL") ??
  Deno.env.get("SUPABASE_DATABASE_URL") ??
  Deno.env.get("HOT_UPDATER_SUPABASE_DATABASE_URL") ??
  "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const functionBasePath = `/${functionName}`;
const hotUpdaterBasePath = "/";

const hotUpdater = createHotUpdater({
  database: supabaseEdgeFunctionDatabase({
    connectionString: supabaseDbUrl,
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

const app = new Hono().basePath(functionBasePath);

app.get("/ping", (c) => c.text("pong"));
app.mount(hotUpdaterBasePath, hotUpdater.handler);

Deno.serve(app.fetch);
