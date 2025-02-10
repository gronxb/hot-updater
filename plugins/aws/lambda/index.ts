import { APIGatewayEvent, Context } from "aws-lambda";
import { getUpdateInfo } from "./getUpdateInfo";

export async function handler(event: APIGatewayEvent, context: Context) {
  try {
    // 요청 헤더에서 필수 정보 가져오기
    const headers = event.headers;
    const bundleId = headers["x-bundle-id"];
    const appPlatform = headers["x-app-platform"] as "ios" | "android";
    const appVersion = headers["x-app-version"];

    if (!bundleId || !appPlatform || !appVersion) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Missing x-bundle-id, x-app-platform, or x-app-version",
        }),
        headers: { "Content-Type": "application/json" },
      };
    }

    // 🔹 업데이트 정보 가져오기
    const updateInfo = await getUpdateInfo({ platform: appPlatform, appVersion, bundleId });

    // 🔹 업데이트 없음 (204 No Content)
    if (!updateInfo) {
      return {
        statusCode: 204,
        body: JSON.stringify({ message: "No update available" }),
        headers: { "Content-Type": "application/json" },
      };
    }

    // 🔹 업데이트 정보 반환
    return {
      statusCode: 200,
      body: JSON.stringify(updateInfo),
      headers: { "Content-Type": "application/json" },
    };
  } catch (error) {
    console.error("Unhandled error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal Server Error" }),
      headers: { "Content-Type": "application/json" },
    };
  }
}