import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import camelcaseKeys from "npm:camelcase-keys@9.1.3";
import semver from "npm:semver@7.7.1";
import {
  type SupabaseClient,
  createClient,
} from "jsr:@supabase/supabase-js@2.49.4";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const semverSatisfies = (targetAppVersion: string, currentVersion: string) => {
  const currentCoerce = semver.coerce(currentVersion);
  if (!currentCoerce) {
    return false;
  }

  return semver.satisfies(currentCoerce.version, targetAppVersion);
};

/**
 * Filters target app versions that are compatible with the current app version.
 * Returns only versions that are compatible with the current version according to semver rules.
 *
 * @param targetAppVersionList - List of target app versions to filter
 * @param currentVersion - Current app version
 * @returns Array of target app versions compatible with the current version
 */
export const filterCompatibleAppVersions = (
  targetAppVersionList: string[],
  currentVersion: string,
) => {
  const compatibleAppVersionList = targetAppVersionList.filter((version) =>
    semverSatisfies(version, currentVersion),
  );

  return compatibleAppVersionList.sort((a, b) => b.localeCompare(a));
};

const createErrorResponse = (message: string, statusCode: number) => {
  return new Response(JSON.stringify({ code: statusCode, message }), {
    headers: { "Content-Type": "application/json" },
    status: statusCode,
  });
};

const appVersionStrategy = async (
  supabase: SupabaseClient<any, "public", any>,
  {
    appPlatform,
    minBundleId,
    bundleId,
    appVersion,
    channel,
  }: {
    appPlatform: string;
    minBundleId: string;
    bundleId: string;
    appVersion: string;
    channel: string;
  },
) => {
  const { data: appVersionList } = await supabase.rpc(
    "get_target_app_version_list",
    {
      app_platform: appPlatform,
      min_bundle_id: minBundleId || NIL_UUID,
    },
  );
  const compatibleAppVersionList = filterCompatibleAppVersions(
    appVersionList?.map((group) => group.target_app_version) ?? [],
    appVersion,
  );

  return supabase.rpc("get_update_info_by_app_version", {
    app_platform: appPlatform,
    app_version: appVersion,
    bundle_id: bundleId,
    min_bundle_id: minBundleId || NIL_UUID,
    target_channel: channel || "production",
    target_app_version_list: compatibleAppVersionList,
  });
};

const fingerprintHashStrategy = async (
  supabase: SupabaseClient<any, "public", any>,
  {
    appPlatform,
    minBundleId,
    bundleId,
    channel,
    fingerprintHash,
  }: {
    appPlatform: string;
    bundleId: string;
    minBundleId: string | null;
    channel: string | null;
    fingerprintHash: string;
  },
) => {
  return supabase.rpc("get_update_info_by_fingerprint_hash", {
    app_platform: appPlatform,
    bundle_id: bundleId,
    min_bundle_id: minBundleId || NIL_UUID,
    target_channel: channel || "production",
    target_fingerprint_hash: fingerprintHash,
  });
};

Deno.serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      {
        auth: { autoRefreshToken: false, persistSession: false },
      },
    );

    const bundleId = req.headers.get("x-bundle-id") as string;
    const appPlatform = req.headers.get("x-app-platform") as "ios" | "android";
    const appVersion = req.headers.get("x-app-version") as string | null;
    const fingerprintHash = req.headers.get("x-app-version") as string | null;
    const minBundleId = req.headers.get("x-min-bundle-id") as
      | string
      | undefined;
    const channel = req.headers.get("x-channel") as string | undefined;

    if (!appVersion && !fingerprintHash) {
      return createErrorResponse("Missing appVersion or fingerprintHash", 400);
    }

    if (!bundleId || !appPlatform) {
      return createErrorResponse("Missing bundleId and appPlatform", 400);
    }

    const { data, error } = fingerprintHash
      ? await fingerprintHashStrategy(supabase, {
          appPlatform,
          minBundleId: minBundleId || NIL_UUID,
          bundleId,
          channel: channel || "production",
          fingerprintHash,
        })
      : await appVersionStrategy(supabase, {
          appPlatform,
          minBundleId: minBundleId || NIL_UUID,
          bundleId,
          appVersion: appVersion!,
          channel: channel || "production",
        });

    if (error) {
      throw error;
    }

    const response = data[0] ? camelcaseKeys(data[0]) : null;
    if (!response) {
      return new Response(JSON.stringify(null), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }

    if (response.id === NIL_UUID) {
      return new Response(
        JSON.stringify({
          ...response,
          fileUrl: null,
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );
    }

    const storageUri = new URL(response.storageUri);
    const storageBucket = storageUri.host;
    const storagePath = storageUri.pathname;

    const { data: signedUrlData } = await supabase.storage
      .from(storageBucket)
      .createSignedUrl(storagePath, 60);

    return new Response(
      JSON.stringify({
        ...response,
        fileUrl: signedUrlData?.signedUrl ?? null,
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (err: unknown) {
    return createErrorResponse(
      err instanceof Error ? err.message : "Unknown error",
      500,
    );
  }
});
