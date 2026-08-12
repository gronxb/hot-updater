import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createHotUpdater } from "@hot-updater/server";
import {
  supabaseDatabase,
  supabaseStorage,
  supabaseStorageDelivery,
} from "@hot-updater/supabase/edge";
import { Hono } from "npm:hono";

declare global {
  var HotUpdater: {
    BUCKET_NAME: string;
    FUNCTION_NAME: string;
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
  features: { analytics: true },
  storages: [
    supabaseStorage({
      supabaseUrl,
      supabaseServiceRoleKey,
      bucketName,
    }),
  ],
  storageDelivery: supabaseStorageDelivery({
    supabaseUrl,
    supabaseServiceRoleKey,
    bucketName,
  }),
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
