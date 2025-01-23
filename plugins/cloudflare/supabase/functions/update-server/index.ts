import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import camelcaseKeys from "npm:camelcase-keys@9.1.3";
import { createClient } from "jsr:@supabase/supabase-js@2.47.10";

// 에러 응답 생성 함수
const createErrorResponse = (message: string, statusCode: number) => {
  return new Response(JSON.stringify({ code: statusCode, message }), {
    headers: { "Content-Type": "application/json" },
    status: statusCode,
  });
};

Deno.serve(async (req) => {
  try {
    // Supabase 클라이언트 초기화
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization")! },
        },
      },
    );

    // 요청 헤더에서 필요한 정보 추출
    const bundleId = req.headers.get("x-bundle-id") as string;
    const appPlatform = req.headers.get("x-app-platform") as "ios" | "android";
    const appVersion = req.headers.get("x-app-version") as string;

    // 필수 헤더 검증
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
