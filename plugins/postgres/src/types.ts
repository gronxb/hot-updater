export type Platforms = "android" | "ios";

export interface BundlesTable {
  enabled: boolean;
  file: string;
  force_update: boolean;
  hash: string;
  id: string;
  message: string | null;
  platform: Platforms;
  target_version: string;
}

export interface Database {
  bundles: BundlesTable;
}
