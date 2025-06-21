import type { GetBundlesArgs, Platform, UpdateInfo } from "@hot-updater/core";

// Cloudflare Workers types
declare global {
  interface D1Database {
    prepare(query: string): D1PreparedStatement;
  }

  interface D1PreparedStatement {
    bind(...values: any[]): D1PreparedStatement;
    first(): Promise<any>;
    all(): Promise<{ results: any[] }>;
  }

  interface R2Bucket {
    url: string;
    createMultipartUpload(key: string): Promise<any>;
  }
}

export type StorageUri = `${string}://${string}/${string}`;

export interface DatabaseAdapter {
  readonly name: string;
  readonly dependencies?: readonly string[];
  getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null>;
  getTargetAppVersions(
    platform: Platform,
    minBundleId: string,
  ): Promise<string[]>;
}

export interface StorageAdapter {
  readonly name: string;
  readonly supportedSchemas: readonly string[];
  getSignedUrl(storageUri: StorageUri, expiresIn: number): Promise<string>;
}

export interface HotUpdaterConfig {
  database: DatabaseAdapter;
  storage: StorageAdapter;
}

export interface AdapterCompatibility {
  compatible: boolean;
  warnings: string[];
  errors: string[];
}

