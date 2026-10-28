import { secretEnv } from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import { getConfigScaffold } from "./configTemplate";
import { initProvider } from "./init/index";

const secretEnvNames = (text: string) =>
  /secretEnv\(\[([^\]]*)\]\)/u
    .exec(text)?.[1]
    ?.match(/"[A-Z0-9_]+"/gu)
    ?.map((name) => JSON.parse(name) as string);

describe("Azure config scaffold", () => {
  it("names the Cosmos DB account and reads both connection strings with secretEnv", () => {
    expect(
      getConfigScaffold("bare", {
        cosmosEndpoint: "https://hot-updater-abc.documents.azure.com:443/",
      }).text,
    ).toMatchInlineSnapshot(`
      "import { azureBlobStorage, cosmosDatabase } from "@hot-updater/azure";
      import { bare } from "@hot-updater/bare";
      import { defineConfig, localSecrets, secretEnv } from "hot-updater";
      import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
      import { existsSync } from "node:fs";

      if (existsSync(".env.hotupdater")) {
        process.loadEnvFile(".env.hotupdater");
      }

      const deploySecrets = secretEnv([
        "HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING",
        "HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING",
      ]);

      export default defineConfig({
        build: bare({ enableHermes: true }),
        storage: azureBlobStorage({
          connectionString: async () =>
            (await deploySecrets()).HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING,
          containerName: "hot-updater",
        }),
        database: cosmosDatabase({
          endpoint: "https://hot-updater-abc.documents.azure.com:443/",
          connectionString: async () =>
            (await deploySecrets()).HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING,
        }),
        plugins: [apiKeys(), insights(), remoteConfig()],
        secrets: localSecrets(),
        updateStrategy: "appVersion", // or "fingerprint"
      });"
    `);
  });

  it("reads the same credentials init stores in a team store", () => {
    expect(
      secretEnvNames(
        getConfigScaffold("bare", {
          cosmosEndpoint: "https://hot-updater-abc.documents.azure.com:443/",
        }).text,
      ),
    ).toEqual(initProvider.secrets);
  });

  it("reads every value from the environment for the agent scaffold", () => {
    expect(getConfigScaffold("bare").text).not.toContain("secretEnv");
  });

  it("names variables secretEnv takes", () => {
    expect(() => secretEnv(initProvider.secrets)).not.toThrow();
  });
});
