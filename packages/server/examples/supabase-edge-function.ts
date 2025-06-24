// New Supabase Edge Function using @hot-updater/server
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { HotUpdater, supabaseDatabase, supabaseStorage } from "@hot-updater/server";

declare global {
  var HotUpdater: {
    FUNCTION_NAME: string;
  };
}

const hotUpdater = new HotUpdater({
  database: supabaseDatabase({
    url: Deno.env.get("SUPABASE_URL")!,
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  }),
  storage: supabaseStorage({
    url: Deno.env.get("SUPABASE_URL")!,
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  })
});

// Add base path support
const functionName = HotUpdater.FUNCTION_NAME;

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  
  // Remove base path if present
  if (url.pathname.startsWith(`/${functionName}`)) {
    url.pathname = url.pathname.slice(`/${functionName}`.length) || '/';
    const modifiedRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return hotUpdater.handler(modifiedRequest);
  }
  
  return hotUpdater.handler(request);
});