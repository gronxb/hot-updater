import type { GetBundlesArgs, Platform, UpdateInfo } from "@hot-updater/core";

export type StorageUri = `${string}://${string}/${string}`;

export interface DatabaseAdapter {
  readonly name: string;
  readonly dependencies?: readonly string[];
  getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null>;
  getTargetAppVersions(platform: Platform, minBundleId: string): Promise<string[]>;
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