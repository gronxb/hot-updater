import { 
  type GetBundlesArgs, 
  type Platform, 
  type UpdateInfo,
  NIL_UUID 
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import type { DatabaseAdapter } from "@hot-updater/plugin-core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseDatabaseConfig {
  url: string;
  serviceRoleKey: string;
}

export function supabaseDatabase(config: SupabaseDatabaseConfig): DatabaseAdapter {
  const supabase = createClient(
    config.url,
    config.serviceRoleKey,
    {
      auth: { autoRefreshToken: false, persistSession: false }
    }
  );

  return {
    name: 'supabase',
    dependencies: ['supabase-storage', 'cloudfront', 'r2', 'firebase-storage'],
    
    async getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null> {
      switch (args._updateStrategy) {
        case "appVersion":
          return appVersionStrategy(supabase, args);
        case "fingerprint":
          return fingerprintStrategy(supabase, args);
        default:
          return null;
      }
    },
    
    async getTargetAppVersions(platform: Platform, minBundleId: string): Promise<string[]> {
      const { data } = await supabase.rpc('get_target_app_version_list', {
        app_platform: platform,
        min_bundle_id: minBundleId || NIL_UUID,
      });
      
      return data?.map((group: any) => group.target_app_version) ?? [];
    }
  };
}

async function appVersionStrategy(
  supabase: SupabaseClient,
  args: GetBundlesArgs & { _updateStrategy: "appVersion" }
): Promise<UpdateInfo | null> {
  const { platform, appVersion, bundleId, minBundleId, channel } = args;
  
  const { data: appVersionList } = await supabase.rpc("get_target_app_version_list", {
    app_platform: platform,
    min_bundle_id: minBundleId || NIL_UUID,
  });
  
  const compatibleAppVersionList = filterCompatibleAppVersions(
    appVersionList?.map((group: any) => group.target_app_version) ?? [],
    appVersion,
  );

  const { data, error } = await supabase.rpc("get_update_info_by_app_version", {
    app_platform: platform,
    app_version: appVersion,
    bundle_id: bundleId,
    min_bundle_id: minBundleId || NIL_UUID,
    target_channel: channel || "production",
    target_app_version_list: compatibleAppVersionList,
  });

  if (error) {
    throw error;
  }

  const result = data?.[0];
  if (!result) {
    return null;
  }

  return {
    id: result.id,
    shouldForceUpdate: result.should_force_update,
    message: result.message,
    status: result.status,
    storageUri: result.storage_uri,
  };
}

async function fingerprintStrategy(
  supabase: SupabaseClient,
  args: GetBundlesArgs & { _updateStrategy: "fingerprint" }
): Promise<UpdateInfo | null> {
  const { platform, fingerprintHash, bundleId, minBundleId, channel } = args;
  
  const { data, error } = await supabase.rpc("get_update_info_by_fingerprint_hash", {
    app_platform: platform,
    bundle_id: bundleId,
    min_bundle_id: minBundleId || NIL_UUID,
    target_channel: channel || "production",
    target_fingerprint_hash: fingerprintHash,
  });

  if (error) {
    throw error;
  }

  const result = data?.[0];
  if (!result) {
    return null;
  }

  return {
    id: result.id,
    shouldForceUpdate: result.should_force_update,
    message: result.message,
    status: result.status,
    storageUri: result.storage_uri,
  };
}