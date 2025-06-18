import type { GetBundlesArgs, Platform, UpdateInfo, AppUpdateInfo } from "@hot-updater/core";
import type { HotUpdaterConfig } from "./adapters";
import { validateAdapterCompatibility } from "./compatibility";

export class HotUpdater {
  private config: HotUpdaterConfig;

  constructor(config: HotUpdaterConfig) {
    // Validate adapter compatibility
    const compatibility = validateAdapterCompatibility(config.database, config.storage);
    
    if (!compatibility.compatible) {
      throw new Error(`Adapter compatibility error: ${compatibility.errors.join(', ')}`);
    }
    
    if (compatibility.warnings.length > 0) {
      console.warn('Adapter compatibility warnings:', compatibility.warnings.join(', '));
    }
    
    this.config = config;
  }

  async handler(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const method = request.method;
      
      // Route to appropriate handler based on path
      if (url.pathname.endsWith('/ping')) {
        return this.handlePing();
      }
      
      if (url.pathname.includes('/check-update')) {
        return this.handleCheckUpdate(request, url);
      }
      
      // Handle signed URL requests (for file downloads)
      if (method === 'GET' && url.searchParams.has('token')) {
        return this.handleSignedUrl(request, url);
      }
      
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Internal server error' 
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }

  private handlePing(): Response {
    return new Response('pong', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  private async handleCheckUpdate(request: Request, url: URL): Promise<Response> {
    const updateConfig = this.parseUpdateRequest(request, url);
    
    if (!updateConfig) {
      return new Response(
        JSON.stringify({ error: 'Invalid request parameters' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    const updateInfo = await this.config.database.getUpdateInfo(updateConfig);
    
    if (!updateInfo) {
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Generate signed URL if needed
    const appUpdateInfo: AppUpdateInfo = {
      ...updateInfo,
      fileUrl: updateInfo.storageUri 
        ? await this.config.storage.getSignedUrl(updateInfo.storageUri as any, 3600)
        : null
    };

    return new Response(JSON.stringify(appUpdateInfo), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private parseUpdateRequest(request: Request, url: URL): GetBundlesArgs | null {
    try {
      // Parse from headers (original format)
      const bundleId = request.headers.get('x-bundle-id');
      const platform = request.headers.get('x-app-platform') as Platform;
      const appVersion = request.headers.get('x-app-version');
      const fingerprintHash = request.headers.get('x-fingerprint-hash');
      const minBundleId = request.headers.get('x-min-bundle-id');
      const channel = request.headers.get('x-channel');

      if (bundleId && platform && (appVersion || fingerprintHash)) {
        return fingerprintHash ? {
          _updateStrategy: 'fingerprint',
          platform,
          bundleId,
          fingerprintHash,
          minBundleId: minBundleId || undefined,
          channel: channel || undefined
        } : {
          _updateStrategy: 'appVersion',
          platform,
          bundleId,
          appVersion: appVersion!,
          minBundleId: minBundleId || undefined,
          channel: channel || undefined
        };
      }

      // Parse from URL path parameters
      const pathParts = url.pathname.split('/').filter(Boolean);
      
      if (pathParts.includes('app-version') && pathParts.length >= 6) {
        const [, , platform, appVersion, channel, minBundleId, bundleId] = pathParts;
        return {
          _updateStrategy: 'appVersion',
          platform: platform as Platform,
          appVersion,
          bundleId,
          minBundleId: minBundleId || undefined,
          channel: channel || undefined
        };
      }
      
      if (pathParts.includes('fingerprint') && pathParts.length >= 6) {
        const [, , platform, fingerprintHash, channel, minBundleId, bundleId] = pathParts;
        return {
          _updateStrategy: 'fingerprint',
          platform: platform as Platform,
          fingerprintHash,
          bundleId,
          minBundleId: minBundleId || undefined,
          channel: channel || undefined
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  private async handleSignedUrl(request: Request, url: URL): Response {
    // This is a placeholder for handling signed URLs
    // Different storage adapters may implement their own token verification
    return new Response(JSON.stringify({ error: 'Signed URL handling not implemented' }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}