import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "npm:hono";

declare global {
  var HotUpdater: {
    FUNCTION_NAME: string;
    SERVER_RUNTIME_SPECIFIER: string;
    SUPABASE_SPECIFIER: string;
  };
}

const { createHotUpdater } = await import(HotUpdater.SERVER_RUNTIME_SPECIFIER);
const { supabaseEdgeFunctionDatabase, supabaseEdgeFunctionStorage } =
  await import(HotUpdater.SUPABASE_SPECIFIER);

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

const app = new Hono().basePath(functionBasePath);

app.get("/ping", (c) => c.text("pong"));
app.mount(hotUpdaterBasePath, hotUpdater.handler);

Deno.serve(app.fetch);
