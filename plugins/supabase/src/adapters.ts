import { 
  type GetBundlesArgs, 
  type Platform, 
  type UpdateInfo,
  NIL_UUID 
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import type { DatabaseAdapter, StorageAdapter, StorageUri } from "@hot-updater/plugin-core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseNodeDatabaseConfig {
  url: string;
  serviceRoleKey: string;
}

export interface SupabaseNodeStorageConfig {
  url: string;
  serviceRoleKey: string;
}

export function supabaseNodeDatabase(config: SupabaseNodeDatabaseConfig): DatabaseAdapter {
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

export function supabaseNodeStorage(config: SupabaseNodeStorageConfig): StorageAdapter {
  const supabase = createClient(
    config.url,
    config.serviceRoleKey,
    {
      auth: { autoRefreshToken: false, persistSession: false }
    }
  );

  return {
    name: 'supabase-storage',
    supportedSchemas: ['supabase-storage'],
    
    async getSignedUrl(storageUri: StorageUri, expiresIn: number): Promise<string> {
      // Parse storage URI: supabase-storage://bucket/path/to/file
      const url = new URL(storageUri);
      const bucket = url.host;
      const path = url.pathname.substring(1); // Remove leading slash
      
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, expiresIn);
      
      if (error) {
        throw new Error(`Failed to create signed URL: ${error.message}`);
      }
      
      if (!data?.signedUrl) {
        throw new Error('No signed URL returned from Supabase');
      }
      
      return data.signedUrl;
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