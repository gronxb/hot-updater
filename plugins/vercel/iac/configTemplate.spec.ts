import { secretEnv } from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import { getConfigScaffold } from "./configTemplate";
import { initProvider } from "./init/index";

const secretEnvNames = (text: string) =>
  [...text.matchAll(/secretEnv\(\[([^\]]*)\]\)/gu)]
    .flatMap(([, list]) => list!.match(/"[A-Z0-9_]+"/gu) ?? [])
    .map((name) => JSON.parse(name) as string)
    .sort();

describe("Vercel config scaffold", () => {
  it("reads the Blob token and the database URL with secretEnv", () => {
    expect(getConfigScaffold("bare", { secretEnv: true }).text)
      .toMatchInlineSnapshot(`
      "import { bare } from "@hot-updater/bare";
      import { postgres, vercelBlobStorage } from "@hot-updater/vercel";
      import { defineConfig, localSecrets, secretEnv } from "hot-updater";
      import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
      import { existsSync } from "node:fs";

      if (existsSync(".env.hotupdater")) {
        process.loadEnvFile(".env.hotupdater");
      }

      const storageSecrets = secretEnv([
        "HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN",
      ]);

      const databaseSecrets = secretEnv([
        "HOT_UPDATER_VERCEL_DATABASE_URL",
      ]);

      export default defineConfig({
        build: bare({ enableHermes: true }),
        storage: vercelBlobStorage({
          token: async () =>
            (await storageSecrets()).HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN,
        }),
        database: postgres({
          connectionString: async () =>
            (await databaseSecrets()).HOT_UPDATER_VERCEL_DATABASE_URL,
        }),
        plugins: [apiKeys(), insights(), remoteConfig()],
        secrets: localSecrets(),
        updateStrategy: "appVersion", // or "fingerprint"
      });"
    `);
  });

  it("reads the same credentials init stores in a team store", () => {
    expect(
      secretEnvNames(getConfigScaffold("bare", { secretEnv: true }).text),
    ).toEqual([...initProvider.secrets].sort());
  });

  it("reads every value from the environment for the agent scaffold", () => {
    expect(getConfigScaffold("bare").text).not.toContain("secretEnv");
  });

  it("names variables secretEnv takes", () => {
    expect(() => secretEnv(initProvider.secrets)).not.toThrow();
  });
});
