import type { StorageAdapter, StorageUri } from "@hot-updater/plugin-core";

export interface CloudfrontStorageConfig {
  keyPairId: string;
  privateKey: string;
}

export function cloudfrontStorage(config: CloudfrontStorageConfig): StorageAdapter {
  return {
    name: 'cloudfront',
    supportedSchemas: ['cloudfront'],
    
    async getSignedUrl(storageUri: StorageUri, expiresIn: number): Promise<string> {
      // TODO: Implement AWS CloudFront signed URL generation
      throw new Error('CloudFront Storage adapter not yet implemented');
    }
  };
}