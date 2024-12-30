export type Platforms = "android" | "ios";

export interface BundlesTable {
  enabled: boolean;
  force_update: boolean;
  file_url: string;
  file_hash: string;
  git_commit_hash: string | null;
  id: string;
  message: string | null;
  platform: Platforms;
  target_app_version: string;
}

export interface Database {
  bundles: BundlesTable;
}
