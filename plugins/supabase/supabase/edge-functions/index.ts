import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  createHotUpdater,
  normalizeBasePath,
  rewriteLegacyExactRequestToCanonical,
  wildcardPattern,
} from "npm:@hot-updater/server/runtime";
import {
  supabaseEdgeFunctionDatabase,
  supabaseEdgeFunctionStorage,
} from "npm:@hot-updater/supabase";
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
const hotUpdaterBasePath = "/api/check-update";
const hotUpdaterMethods = ["GET", "POST", "PATCH", "DELETE"];

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

const stripFunctionBasePath = (request: Request, basePath: string) => {
  const normalizedFunctionBasePath = normalizeBasePath(basePath);

  if (normalizedFunctionBasePath === "/") {
    return request;
  }

  const url = new URL(request.url);

  if (!url.pathname.startsWith(normalizedFunctionBasePath)) {
    return request;
  }

  const nextPathname = url.pathname.slice(normalizedFunctionBasePath.length);
  url.pathname = nextPathname.startsWith("/")
    ? nextPathname
    : `/${nextPathname}`;

  return new Request(url, request);
};

const app = new Hono().basePath(functionBasePath);

app.get("/ping", (c) => c.text("pong"));

app.get(hotUpdaterBasePath, async (c) => {
  const rewrittenRequest = rewriteLegacyExactRequestToCanonical({
    basePath: hotUpdater.basePath,
    request: c.req.raw,
  });

  if (rewrittenRequest instanceof Response) {
    return rewrittenRequest;
  }

  return hotUpdater.handler(rewrittenRequest);
});

app.on(hotUpdaterMethods, wildcardPattern(hotUpdaterBasePath), async (c) => {
  const rewrittenRequest = stripFunctionBasePath(c.req.raw, functionBasePath);

  return hotUpdater.handler(rewrittenRequest);
});

Deno.serve(app.fetch);
