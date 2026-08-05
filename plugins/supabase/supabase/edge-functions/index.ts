import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { analytics } from "@hot-updater/analytics";
import { managedBetterAuthPlugin } from "@hot-updater/better-auth/managed";
import { createHotUpdater } from "@hot-updater/server";
import {
  supabaseEdgeFunctionDatabase,
  supabaseEdgeFunctionStorage,
} from "@hot-updater/supabase";
import { Hono } from "npm:hono";

declare global {
  var HotUpdater: {
    API_KEY_SHA256: string;
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
  plugins: [
    managedBetterAuthPlugin({ apiKeySha256: HotUpdater.API_KEY_SHA256 }),
    analytics(),
  ],
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
