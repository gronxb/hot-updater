import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import camelcaseKeys from "npm:camelcase-keys@9.1.3";
import { createClient } from "jsr:@supabase/supabase-js@2.47.10";

const createErrorResponse = (message: string, statusCode: number) => {
  return new Response(JSON.stringify({ code: statusCode, message }), {
    headers: { "Content-Type": "application/json" },
    status: statusCode,
  });
};

Deno.serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization")! },
        },
      },
    );

    const bundleId = req.headers.get("x-bundle-id") as string;
    const appPlatform = req.headers.get("x-app-platform") as "ios" | "android";
    const appVersion = req.headers.get("x-app-version") as string;

    if (!bundleId || !appPlatform || !appVersion) {
      return createErrorResponse(
        "Missing bundleId, appPlatform, or appVersion",
        400,
      );
    }

    const { data, error } = await supabase.rpc("get_update_info", {
      app_platform: appPlatform,
      app_version: appVersion,
      bundle_id: bundleId,
    });

    if (error) {
      throw error;
    }

    const response = data[0] ? camelcaseKeys(data[0]) : null;
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err: unknown) {
    return createErrorResponse(JSON.stringify(err), 500);
  }
});
