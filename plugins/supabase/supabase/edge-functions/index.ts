import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "jsr:@hono/hono";
import {
  createHotUpdater,
  rewriteLegacyExactRequestToCanonical,
  wildcardPattern,
} from "npm:@hot-updater/server";
import {
  supabaseEdgeFunctionDatabase,
  supabaseEdgeFunctionStorage,
} from "npm:@hot-updater/supabase";

declare global {
  var HotUpdater: {
    FUNCTION_NAME: string;
  };
}

const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"];
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
});

const app = new Hono().basePath(functionBasePath);

app.get("/ping", (c) => c.text("pong"));

app.get(hotUpdater.basePath, async (c) => {
  const rewrittenRequest = rewriteLegacyExactRequestToCanonical({
    basePath: hotUpdater.basePath,
    request: c.req.raw,
  });

  if (rewrittenRequest instanceof Response) {
    return rewrittenRequest;
  }

  return hotUpdater.handler(rewrittenRequest);
});

app.on(HOT_UPDATER_METHODS, wildcardPattern(hotUpdater.basePath), async (c) => {
  return hotUpdater.handler(c.req.raw);
});

Deno.serve(app.fetch);
