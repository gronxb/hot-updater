import type { 
  GetBundlesArgs, 
  UpdateInfo 
} from "@hot-updater/core";
import type { 
  DatabaseAdapter, 
  StorageAdapter 
} from "@hot-updater/plugin-core";
import { getUpdateInfo as adapterGetUpdateInfo } from "@hot-updater/js";
import { toNodeHandler, type NodeHandlerOptions } from "./toNodeHandler";

export interface HotUpdaterConfig {
  database: DatabaseAdapter;
  storage: StorageAdapter[];
}

export interface HotUpdaterHandler {
  (request: Request): Promise<Response>;
}

export class HotUpdater {
  private database: DatabaseAdapter;
  private storage: StorageAdapter[];

  constructor(config: HotUpdaterConfig) {
    this.database = config.database;
    this.storage = config.storage;
  }

  async handleUpdateRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      
      // Parse query parameters
      const args: GetBundlesArgs = {
        platform: url.searchParams.get('platform') as any,
        appVersion: url.searchParams.get('appVersion') || undefined,
        bundleId: url.searchParams.get('bundleId') || undefined,
        minBundleId: url.searchParams.get('minBundleId') || undefined,
        channel: url.searchParams.get('channel') || undefined,
        fingerprintHash: url.searchParams.get('fingerprintHash') || undefined,
        _updateStrategy: url.searchParams.get('fingerprintHash') ? "fingerprint" : "appVersion"
      };

      const updateInfo = await adapterGetUpdateInfo({
        database: this.database,
        storageAdapters: this.storage,
        args
      });

      if (!updateInfo) {
        return new Response(JSON.stringify({ update: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        update: true,
        ...updateInfo
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error("Error getting update info:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  getHandler(): HotUpdaterHandler {
    return this.handleUpdateRequest.bind(this);
  }

  toNodeHandler(options?: NodeHandlerOptions): (req: any, res: any) => Promise<void> {
    return toNodeHandler(this.getHandler(), options);
  }

  /**
   * Direct handler for frameworks that support Web Request/Response
   * Usage: auth.handler(c.req.raw) - similar to better-auth
   */
  handler(request: Request): Promise<Response> {
    return this.handleUpdateRequest(request);
  }
}