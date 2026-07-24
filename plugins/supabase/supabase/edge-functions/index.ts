import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { analytics } from "@hot-updater/analytics";
import { createHotUpdater } from "@hot-updater/server";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase/edge";
import { Hono } from "npm:hono";

declare global {
  var HotUpdater: {
    FUNCTION_NAME: string;
  };
}

const functionName = HotUpdater.FUNCTION_NAME;
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const functionBasePath = `/${functionName}`;
const hotUpdaterBasePath = "/";

const hotUpdater = createHotUpdater({
  database: supabaseDatabase({
    supabaseUrl,
    supabaseServiceRoleKey,
  }),
  storages: [
    supabaseStorage({
      supabaseUrl,
      supabaseServiceRoleKey,
    }),
  ],
  basePath: hotUpdaterBasePath,
  coreRoutes: {
    bundles: false,
    updateCheck: true,
  },
  plugins: [analytics({ missingCapability: "error", queryAccess: "public" })],
});

const app = new Hono().basePath(functionBasePath);

app.get("/ping", (c) => c.text("pong"));
app.mount(hotUpdaterBasePath, hotUpdater.handler);

Deno.serve(app.fetch);
