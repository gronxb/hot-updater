import type { StorageAdapter, StorageUri } from "@hot-updater/plugin-core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseStorageConfig {
  url: string;
  serviceRoleKey: string;
}

export function supabaseStorage(config: SupabaseStorageConfig): StorageAdapter {
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