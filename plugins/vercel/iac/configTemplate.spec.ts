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
    expect(getConfigScaffold("bare").text).toMatchInlineSnapshot(`
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
    expect(secretNames(getConfigScaffold("bare").text)).toEqual(
      [...initProvider.secrets].sort(),
    );
  });

  it("reads every credential with secret(), in init's config and the agent scaffold's", () => {
    for (const { text } of [getConfigScaffold("bare")]) {
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
