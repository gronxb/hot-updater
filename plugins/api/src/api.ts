import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
  ApiPluginResponse,
} from "@hot-updater/plugin-core";

export interface IApiConfig {
  endpoint: string;
  headers: Record<string, string>;
}

export const api =
  (config: IApiConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const headers = {
      "Content-Type": "application/json",
      ...config.headers,
    };

    let bundles: Bundle[] = [];

    return {
      name: "api",
      async commitBundle() {
        const response = await fetch(config.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(bundles),
        });

        if (!response.ok) {
          throw new Error(`API Error: ${response.statusText}`);
        }

        const result = (await response.json()) as ApiPluginResponse;
        if (!result.success) {
          throw new Error("Failed to commit bundles");
        }

        hooks?.onDatabaseUpdated?.();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        bundles = await this.getBundles();

        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }

        Object.assign(bundles[targetIndex], newBundle);
      },
      async appendBundle(inputBundle: Bundle) {
        bundles = await this.getBundles();
        bundles.unshift(inputBundle);
      },
      async setBundles(inputBundles: Bundle[]) {
        bundles = inputBundles;
      },
      async getBundleById(bundleId: string): Promise<Bundle | null> {
        try {
          const response = await fetch(`${config.endpoint}/${bundleId}`, {
            method: "GET",
            headers,
          });

          if (!response.ok) {
            return null;
          }

          return (await response.json()) as Bundle;
        } catch (error) {
          return null;
        }
      },
      async getBundles(refresh = false): Promise<Bundle[]> {
        if (bundles.length > 0 && !refresh) {
          return bundles;
        }

        const response = await fetch(config.endpoint, {
          method: "GET",
          headers,
        });

        if (!response.ok) {
          throw new Error(`API Error: ${response.statusText}`);
        }

        bundles = (await response.json()) as Bundle[];
        return bundles;
      },
    };
  };
