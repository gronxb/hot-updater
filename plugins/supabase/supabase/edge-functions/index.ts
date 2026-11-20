import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createHotUpdater } from "@hot-updater/server";
import { managedPlugins } from "@hot-updater/server/plugins";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase/edge";
import { Hono } from "hono";

declare global {
  var HotUpdater: {
    BUCKET_NAME: string;
    FUNCTION_NAME: string;
    /** The plugins the function runs, as init selected them. */
    PLUGINS: string;
  };
}

const functionName = HotUpdater.FUNCTION_NAME;
const bucketName = HotUpdater.BUCKET_NAME;
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const functionBasePath = `/${functionName}`;
const hotUpdaterBasePath = "/";

const hotUpdater = createHotUpdater({
  database: supabaseDatabase({
    supabaseUrl,
    supabaseServiceRoleKey,
  }),
  ...managedPlugins(HotUpdater.PLUGINS),
  storage: supabaseStorage({
    supabaseUrl,
    supabaseServiceRoleKey,
    bucketName,
  }),
} as Parameters<typeof createHotUpdater>[0]);

const app = new Hono().basePath(functionBasePath);

app.get("/ping", (c) => c.text("pong"));
app.mount(hotUpdaterBasePath, hotUpdater.handlers.client);

Deno.serve(app.fetch);
