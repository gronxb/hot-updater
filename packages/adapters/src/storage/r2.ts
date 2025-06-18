import type { StorageAdapter, StorageUri } from "@hot-updater/plugin-core";
import { withJwtSignedUrl } from "@hot-updater/js";

export interface R2StorageConfig {
  bucket: R2Bucket;
  jwtSecret: string;
}

export function r2Storage(config: R2StorageConfig): StorageAdapter {
  return {
    name: 'r2',
    supportedSchemas: ['r2'],
    
    async getSignedUrl(storageUri: StorageUri, expiresIn: number): Promise<string> {
      // For R2, we use JWT signed URLs as implemented in the existing Cloudflare Worker
      // This would typically be called in the context of a request to generate a proper signed URL
      // For now, we'll return the storageUri as-is and let the calling code handle JWT signing
      
      // TODO: This needs to be properly implemented with JWT signing
      // The actual JWT signing happens in the handler context with the request URL
      throw new Error('R2 storage adapter requires request context for JWT signing. Use withJwtSignedUrl in your handler.');
    }
  };
}