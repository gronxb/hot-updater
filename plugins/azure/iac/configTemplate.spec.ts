import { secret } from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import { getConfigScaffold } from "./configTemplate";
import { initProvider } from "./init/index";

const secretNames = (text: string) =>
  [
    ...new Set(
      [...text.matchAll(/secret\("([^"]+)"\)/gu)].map(([, name]) => name!),
    ),
  ].sort();

describe("Azure config scaffold", () => {
  it("names the Cosmos DB account and reads both connection strings with secret()", () => {
    expect(
      getConfigScaffold("bare", {
        cosmosEndpoint: "https://hot-updater-abc.documents.azure.com:443/",
      }).text,
    ).toMatchInlineSnapshot(`
      "import { azureBlobStorage, cosmosDatabase } from "@hot-updater/azure";
      import { bare } from "@hot-updater/bare";
      import { defineConfig, localSecrets, secret } from "hot-updater";
      import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
      import { existsSync } from "node:fs";

      if (existsSync(".env.hotupdater")) {
        process.loadEnvFile(".env.hotupdater");
      }

      export default defineConfig({
        build: bare({ enableHermes: true }),
        storage: azureBlobStorage({
          connectionString: secret("HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING"),
          containerName: "hot-updater",
        }),
        database: cosmosDatabase({
          endpoint: "https://hot-updater-abc.documents.azure.com:443/",
          connectionString: secret("HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING"),
        }),
        plugins: [apiKeys(), insights(), remoteConfig()],
        secrets: localSecrets(),
        updateStrategy: "appVersion", // or "fingerprint"
      });"
    `);
  });

  it("reads the same credentials init stores in a team store", () => {
    expect(
      secretNames(
        getConfigScaffold("bare", {
          cosmosEndpoint: "https://hot-updater-abc.documents.azure.com:443/",
        }).text,
      ),
    ).toEqual([...initProvider.secrets].sort());
  });

  it("reads every credential with secret(), in init's config and the agent scaffold's", () => {
    for (const { text } of [
      getConfigScaffold("bare", {
        cosmosEndpoint: "https://hot-updater-abc.documents.azure.com:443/",
      }),
      getConfigScaffold("bare"),
    ]) {
      expect(text).not.toMatch(/secretEnv|"secret:/u);
      for (const name of initProvider.secrets) {
        expect(text).toContain(`secret("${name}")`);
        expect(text).not.toContain(`process.env.${name}`);
      }
    }
  });

  it("names secrets secret() takes", () => {
    expect(() =>
      initProvider.secrets.map((name) => secret(name)),
    ).not.toThrow();
  });
});
