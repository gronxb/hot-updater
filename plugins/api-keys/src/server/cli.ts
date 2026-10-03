import type { PluginCli } from "@hot-updater/plugin-core";

import type { CreatedApiKey } from "./apiKeys";

/** The part of the apiKeys() API that its clientCredential uses. */
export interface ApiKeysCliApi {
  provision(input: {
    readonly existingApiKey?: string;
    readonly name: string;
  }): Promise<CreatedApiKey>;
}

/** The environment variable init stores the app's API key in. */
export const API_KEY_ENV = "HOT_UPDATER_API_KEY";

/** A new API key: 32 random bytes, base64url, as the plugin creates them. */
const generateApiKey = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

/** The API key that init provisions for an app, sent in `headerName`. */
export const apiKeysCli = (headerName: string): PluginCli<ApiKeysCliApi> => ({
  clientCredential: {
    label: "API key",
    header: headerName,
    env: API_KEY_ENV,
    generate: generateApiKey,
    provision: async (api, { existing, name }) =>
      (
        await api.provision({
          ...(existing === undefined ? {} : { existingApiKey: existing }),
          name,
        })
      ).apiKey,
  },
});
