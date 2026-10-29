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

describe("Vercel config scaffold", () => {
  it("reads the Blob token and the database URL with secret()", () => {
    expect(getConfigScaffold("bare", { secrets: true }).text)
      .toMatchInlineSnapshot(`
        "import { bare } from "@hot-updater/bare";
        import { postgres, vercelBlobStorage } from "@hot-updater/vercel";
        import { defineConfig, localSecrets, secret } from "hot-updater";
        import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
        import { existsSync } from "node:fs";

        if (existsSync(".env.hotupdater")) {
          process.loadEnvFile(".env.hotupdater");
        }

        export default defineConfig({
          build: bare({ enableHermes: true }),
          storage: vercelBlobStorage({
            token: secret("HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN"),
          }),
          database: postgres({
            connectionString: secret("HOT_UPDATER_VERCEL_DATABASE_URL"),
          }),
          plugins: [apiKeys(), insights(), remoteConfig()],
          secrets: localSecrets(),
          updateStrategy: "appVersion", // or "fingerprint"
        });"
      `);
  });

  it("reads the same credentials init stores in a team store", () => {
    expect(
      secretNames(getConfigScaffold("bare", { secrets: true }).text),
    ).toEqual([...initProvider.secrets].sort());
  });

  it("reads every value from the environment for the agent scaffold", () => {
    expect(getConfigScaffold("bare").text).not.toContain("secret(");
  });

  it("names secrets secret() takes", () => {
    expect(() =>
      initProvider.secrets.map((name) => secret(name)),
    ).not.toThrow();
  });
});
