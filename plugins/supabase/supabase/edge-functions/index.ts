import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "jsr:@hono/hono";
import {
  createClient,
  type SupabaseClient,
} from "jsr:@supabase/supabase-js@2.49.4";
import semver from "npm:semver@7.7.1";
import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";

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

const handleUpdateRequest = async (
  supabase: SupabaseClient<any, "public", any>,
  updateConfig: GetBundlesArgs,
) => {
  const { data, error } =
    updateConfig._updateStrategy === "fingerprint"
      ? await fingerprintHashStrategy(supabase, {
          appPlatform: updateConfig.platform,
          minBundleId: updateConfig.minBundleId!,
          bundleId: updateConfig.bundleId,
          channel: updateConfig.channel!,
          fingerprintHash: updateConfig.fingerprintHash!,
        })
      : await appVersionStrategy(supabase, {
          appPlatform: updateConfig.platform,
          minBundleId: updateConfig.minBundleId!,
          bundleId: updateConfig.bundleId,
          appVersion: updateConfig.appVersion!,
          channel: updateConfig.channel!,
        });

  if (error) {
    throw error;
  }

  const storageUri = data[0]?.storage_uri;
  const response = data[0]
    ? ({
        id: data[0].id,
        shouldForceUpdate: data[0].should_force_update,
        message: data[0].message,
        status: data[0].status,
      } as UpdateInfo)
    : null;

  if (!response) {
    return null;
  }

  if (response.id === NIL_UUID) {
    return {
      ...response,
      fileUrl: null,
    };
  }

  const storageURL = new URL(storageUri);
  const storageBucket = storageURL.host;
  const storagePath = storageURL.pathname;

  const { data: signedUrlData } = await supabase.storage
    .from(storageBucket)
    .createSignedUrl(storagePath, 60);

  return {
    ...response,
    fileUrl: signedUrlData?.signedUrl ?? null,
  };
};

declare global {
  var HotUpdater: {
    FUNCTION_NAME: string;
  };
}

const functionName = HotUpdater.FUNCTION_NAME;
const app = new Hono().basePath(`/${functionName}`);

app.get("/ping", (c) => c.text("pong"));

app.get("/", async (c) => {
  try {
    const bundleId = c.req.header("x-bundle-id");
    const appPlatform = c.req.header("x-app-platform") as "ios" | "android";
    const appVersion = c.req.header("x-app-version");
    const fingerprintHash = c.req.header("x-fingerprint-hash");
    const minBundleId = c.req.header("x-min-bundle-id");
    const channel = c.req.header("x-channel");

    if (!appVersion && !fingerprintHash) {
      return c.json(
        {
          error:
            "Missing required headers (x-app-version or x-fingerprint-hash).",
        },
        400,
      );
    }

    if (!bundleId || !appPlatform) {
      return c.json(
        { error: "Missing required headers (x-app-platform, x-bundle-id)." },
        400,
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      {
        auth: { autoRefreshToken: false, persistSession: false },
      },
    );

    const updateConfig = fingerprintHash
      ? ({
          platform: appPlatform,
          fingerprintHash,
          bundleId,
          minBundleId: minBundleId || NIL_UUID,
          channel: channel || "production",
          _updateStrategy: "fingerprint" as const,
        } satisfies GetBundlesArgs)
      : ({
          platform: appPlatform,
          appVersion: appVersion!,
          bundleId,
          minBundleId: minBundleId || NIL_UUID,
          channel: channel || "production",
          _updateStrategy: "appVersion" as const,
        } satisfies GetBundlesArgs);

    const result = await handleUpdateRequest(supabase, updateConfig);
    return c.json(result);
  } catch (err: unknown) {
    return c.json(
      {
        error: err instanceof Error ? err.message : "Unknown error",
      },
      500,
    );
  }
});

app.get(
  "/app-version/:platform/:app-version/:channel/:minBundleId/:bundleId",
  async (c) => {
    try {
      const {
        platform,
        "app-version": appVersion,
        channel,
        minBundleId,
        bundleId,
      } = c.req.param();

      if (!bundleId || !platform) {
        return c.json(
          { error: "Missing required parameters (platform, bundleId)." },
          400,
        );
      }

      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        {
          auth: { autoRefreshToken: false, persistSession: false },
        },
      );

      const updateConfig = {
        platform: platform as "ios" | "android",
        appVersion,
        bundleId,
        minBundleId: minBundleId || NIL_UUID,
        channel: channel || "production",
        _updateStrategy: "appVersion" as const,
      } satisfies GetBundlesArgs;

      const result = await handleUpdateRequest(supabase, updateConfig);
      return c.json(result);
    } catch (err: unknown) {
      return c.json(
        {
          error: err instanceof Error ? err.message : "Unknown error",
        },
        500,
      );
    }
  },
);

app.get(
  "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId",
  async (c) => {
    try {
      const { platform, fingerprintHash, channel, minBundleId, bundleId } =
        c.req.param();

      if (!bundleId || !platform) {
        return c.json(
          { error: "Missing required parameters (platform, bundleId)." },
          400,
        );
      }

      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        {
          auth: { autoRefreshToken: false, persistSession: false },
        },
      );

      const updateConfig = {
        platform: platform as "ios" | "android",
        fingerprintHash,
        bundleId,
        minBundleId: minBundleId || NIL_UUID,
        channel: channel || "production",
        _updateStrategy: "fingerprint" as const,
      } satisfies GetBundlesArgs;

      const result = await handleUpdateRequest(supabase, updateConfig);
      return c.json(result);
    } catch (err: unknown) {
      return c.json(
        {
          error: err instanceof Error ? err.message : "Unknown error",
        },
        500,
      );
    }
  },
);

Deno.serve(app.fetch);
