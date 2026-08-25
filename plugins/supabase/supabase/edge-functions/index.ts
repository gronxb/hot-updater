import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createHotUpdater } from "@hot-updater/server";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase/edge";
import { Hono } from "hono";

declare global {
  var HotUpdater: {
    AUTHORITY_ID: string;
    BUCKET_NAME: string;
    FUNCTION_NAME: string;
  };
}

const functionName = HotUpdater.FUNCTION_NAME;
const authorityId = HotUpdater.AUTHORITY_ID;
const bucketName = HotUpdater.BUCKET_NAME;
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const functionBasePath = `/${functionName}`;
const hotUpdaterBasePath = "/";

const hotUpdater = createHotUpdater({
  authorityId,
  database: supabaseDatabase({
    supabaseUrl,
    supabaseServiceRoleKey,
  }),
  clientAccess: { type: "api-key" },
  storage: [
    supabaseStorage({
      supabaseUrl,
      supabaseServiceRoleKey,
      bucketName,
    }),
  ],
});

const app = new Hono().basePath(functionBasePath);

app.get("/ping", (c) => c.text("pong"));
app.mount(hotUpdaterBasePath, hotUpdater.handlers.client);

Deno.serve(app.fetch);
