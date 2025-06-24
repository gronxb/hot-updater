import { NIL_UUID, type GetBundlesArgs, type Platform } from "@hot-updater/core";
import type { HotUpdaterConfig, UpdateResponse, StorageUri } from "./types";
import { validateAdapterCompatibility } from "./compatibility";

export class HotUpdater {
  constructor(private config: HotUpdaterConfig) {
    const compatibility = validateAdapterCompatibility(config.database, config.storage);
    if (!compatibility.compatible) {
      throw new Error(`Adapter compatibility error: ${compatibility.errors.join(', ')}`);
    }
  }

  async handler(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // Health check endpoint
      if (path === "/ping" || path.endsWith("/ping")) {
        return new Response("pong", { status: 200 });
      }

      // Header-based endpoint (legacy support)
      if (path === "/" || path === "/api/check-update" || path.endsWith("/api/check-update")) {
        return this.handleHeaderBasedRequest(request);
      }

      // URL parameter-based endpoints
      const appVersionMatch = path.match(
        /\/app-version\/([^\/]+)\/([^\/]+)\/([^\/]+)\/([^\/]+)\/([^\/]+)$/
      );
      if (appVersionMatch) {
        const [, platform, appVersion, channel, minBundleId, bundleId] = appVersionMatch;
        return this.handleAppVersionRequest(platform, appVersion, channel, minBundleId, bundleId);
      }

      const fingerprintMatch = path.match(
        /\/fingerprint\/([^\/]+)\/([^\/]+)\/([^\/]+)\/([^\/]+)\/([^\/]+)$/
      );
      if (fingerprintMatch) {
        const [, platform, fingerprintHash, channel, minBundleId, bundleId] = fingerprintMatch;
        return this.handleFingerprintRequest(platform, fingerprintHash, channel, minBundleId, bundleId);
      }

      return new Response(
        JSON.stringify({ error: "Not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown error",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  private async handleHeaderBasedRequest(request: Request): Promise<Response> {
    const bundleId = request.headers.get("x-bundle-id");
    const appPlatform = request.headers.get("x-app-platform") as Platform;
    const appVersion = request.headers.get("x-app-version");
    const fingerprintHash = request.headers.get("x-fingerprint-hash");
    const minBundleId = request.headers.get("x-min-bundle-id");
    const channel = request.headers.get("x-channel");

    if (!appVersion && !fingerprintHash) {
      return new Response(
        JSON.stringify({
          error: "Missing required headers (x-app-version or x-fingerprint-hash).",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!bundleId || !appPlatform) {
      return new Response(
        JSON.stringify({
          error: "Missing required headers (x-app-platform, x-bundle-id).",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const updateConfig: GetBundlesArgs = fingerprintHash
      ? {
          platform: appPlatform,
          fingerprintHash,
          bundleId,
          minBundleId: minBundleId || NIL_UUID,
          channel: channel || "production",
          _updateStrategy: "fingerprint" as const,
        }
      : {
          platform: appPlatform,
          appVersion: appVersion!,
          bundleId,
          minBundleId: minBundleId || NIL_UUID,
          channel: channel || "production",
          _updateStrategy: "appVersion" as const,
        };

    const result = await this.handleUpdateRequest(updateConfig);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  private async handleAppVersionRequest(
    platform: string,
    appVersion: string,
    channel: string,
    minBundleId: string,
    bundleId: string
  ): Promise<Response> {
    if (!bundleId || !platform) {
      return new Response(
        JSON.stringify({
          error: "Missing required parameters (platform, bundleId).",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const updateConfig: GetBundlesArgs = {
      platform: platform as Platform,
      appVersion,
      bundleId,
      minBundleId: minBundleId || NIL_UUID,
      channel: channel || "production",
      _updateStrategy: "appVersion" as const,
    };

    const result = await this.handleUpdateRequest(updateConfig);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  private async handleFingerprintRequest(
    platform: string,
    fingerprintHash: string,
    channel: string,
    minBundleId: string,
    bundleId: string
  ): Promise<Response> {
    if (!bundleId || !platform) {
      return new Response(
        JSON.stringify({
          error: "Missing required parameters (platform, bundleId).",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const updateConfig: GetBundlesArgs = {
      platform: platform as Platform,
      fingerprintHash,
      bundleId,
      minBundleId: minBundleId || NIL_UUID,
      channel: channel || "production",
      _updateStrategy: "fingerprint" as const,
    };

    const result = await this.handleUpdateRequest(updateConfig);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  private async handleUpdateRequest(updateConfig: GetBundlesArgs): Promise<UpdateResponse | null> {
    const updateInfo = await this.config.database.getUpdateInfo(updateConfig);

    if (!updateInfo) {
      return null;
    }

    if (updateInfo.id === NIL_UUID) {
      return {
        ...updateInfo,
        fileUrl: null,
      };
    }

    if (!updateInfo.storageUri) {
      return {
        ...updateInfo,
        fileUrl: null,
      };
    }

    const signedUrl = await this.config.storage.getSignedUrl(
      updateInfo.storageUri as StorageUri,
      3600 // 1 hour expiry
    );

    return {
      ...updateInfo,
      fileUrl: signedUrl,
    };
  }

  async getUpdateInfo(args: GetBundlesArgs): Promise<UpdateResponse | null> {
    return this.handleUpdateRequest(args);
  }
}