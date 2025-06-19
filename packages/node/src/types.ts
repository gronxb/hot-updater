import type { DatabaseAdapter, StorageAdapter } from "@hot-updater/plugin-core";

export interface NodePluginConfig {
  database: DatabaseAdapter;
  storage: StorageAdapter[];
}

export interface HotUpdaterHandler {
  (request: Request): Promise<Response>;
}