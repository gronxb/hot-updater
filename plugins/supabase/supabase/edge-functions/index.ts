import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createHotUpdater } from "@hot-updater/server";
import {
  createSupabaseNotifyAppReadyResult,
  createSupabaseTelemetryOperations,
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
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const functionBasePath = `/${functionName}`;
const hotUpdaterBasePath = "/";

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
const telemetryOperations = createSupabaseTelemetryOperations({
  supabaseUrl,
  supabaseServiceRoleKey,
});

const app = new Hono().basePath(functionBasePath);

app.get("/ping", (c) => c.text("pong"));
app.post("/api/notify-app-ready", async (c) => {
  const result = await createSupabaseNotifyAppReadyResult({
    operations: telemetryOperations,
    request: c.req.raw,
  });
  return c.json(result.body, result.status);
});
app.mount(hotUpdaterBasePath, hotUpdater.handler);

Deno.serve(app.fetch);
