import type { GetBundlesArgs, UpdateInfo, Platform } from "@hot-updater/core";

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

export interface CompatibilityCheck {
  compatible: boolean;
  errors: string[];
}

export interface UpdateResponse extends Omit<UpdateInfo, 'storageUri'> {
  fileUrl: string | null;
}