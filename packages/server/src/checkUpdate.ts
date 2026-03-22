import type { GetBundlesArgs, Platform } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import type { HotUpdaterAPI } from "./db";

const JSON_HEADERS = {
  "Content-Type": "application/json",
} as const;

const INVALID_PLATFORM_ERROR = "Invalid platform. Must be 'ios' or 'android'.";
const MISSING_BUNDLE_ID_PLATFORM_ERROR =
  "Missing required headers (x-app-platform, x-bundle-id).";
const MISSING_STRATEGY_ERROR =
  "Missing required headers (x-app-version or x-fingerprint-hash).";

const isPlatform = (value: string | null): value is Platform => {
  return value === "ios" || value === "android";
};

const jsonResponse = (body: unknown, status = 200) => {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
};

export type CheckUpdateRequestResult =
  | {
      ok: true;
      args: GetBundlesArgs;
    }
  | {
      ok: false;
      response: Response;
    };

export function parseCheckUpdateRequest(
  request: Request,
): CheckUpdateRequestResult {
  const bundleId = request.headers.get("x-bundle-id");
  const platform = request.headers.get("x-app-platform");
  const appVersion = request.headers.get("x-app-version");
  const minBundleId = request.headers.get("x-min-bundle-id");
  const channel = request.headers.get("x-channel");
  const cohort = request.headers.get("x-cohort");
  const fingerprintHash = request.headers.get("x-fingerprint-hash");

  if (!bundleId || !platform) {
    return {
      ok: false,
      response: jsonResponse({ error: MISSING_BUNDLE_ID_PLATFORM_ERROR }, 400),
    };
  }

  if (!isPlatform(platform)) {
    return {
      ok: false,
      response: jsonResponse({ error: INVALID_PLATFORM_ERROR }, 400),
    };
  }

  if (!appVersion && !fingerprintHash) {
    return {
      ok: false,
      response: jsonResponse({ error: MISSING_STRATEGY_ERROR }, 400),
    };
  }

  if (fingerprintHash) {
    return {
      ok: true,
      args: {
        platform,
        fingerprintHash,
        bundleId,
        minBundleId: minBundleId || NIL_UUID,
        channel: channel || "production",
        cohort: cohort || undefined,
        _updateStrategy: "fingerprint",
      },
    };
  }

  return {
    ok: true,
    args: {
      platform,
      appVersion: appVersion!,
      bundleId,
      minBundleId: minBundleId || NIL_UUID,
      channel: channel || "production",
      cohort: cohort || undefined,
      _updateStrategy: "appVersion",
    },
  };
}

export async function createCheckUpdateResponse(
  hotUpdater: Pick<HotUpdaterAPI, "getAppUpdateInfo">,
  request: Request,
): Promise<Response> {
  const parsed = parseCheckUpdateRequest(request);

  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const result = await hotUpdater.getAppUpdateInfo(parsed.args);
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
}
