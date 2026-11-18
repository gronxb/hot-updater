import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { secret, writeHotUpdaterConfig } from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import { getConfigScaffold } from "./configTemplate";
import { initProvider } from "./init/index";

const secretNames = (text: string) =>
  [
    ...new Set(
      [...text.matchAll(/secret\("([^"]+)"\)/gu)].map(([, name]) => name!),
    ),
  ].sort();

/** hot-updater.config.ts as hot-updater 1.0.2's Vercel init wrote it. */
const CONFIG_1_0_2 = `import { bare } from "@hot-updater/bare";
import { postgres } from "@hot-updater/postgres";
import { vercelBlobStorage } from "@hot-updater/vercel";
import { defineConfig } from "hot-updater";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
import { existsSync } from "node:fs";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: vercelBlobStorage({
    token: process.env.HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN!,
    access:
      process.env.HOT_UPDATER_VERCEL_BLOB_ACCESS === "public"
        ? "public"
        : "private",
  }),
  database: postgres({
    connectionString: process.env.HOT_UPDATER_VERCEL_DATABASE_URL!,
  }),
  plugins: [apiKeys(), insights(), remoteConfig()],
  updateStrategy: "appVersion", // or "fingerprint"
});
`;

describe("Vercel config scaffold", () => {
  it("drops the access option 1.0.2's config passes, which vercelBlobStorage no longer takes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vercel-config-"));
    const configPath = path.join(dir, "hot-updater.config.ts");
    try {
      await fs.writeFile(configPath, CONFIG_1_0_2);

      const result = await writeHotUpdaterConfig(
        getConfigScaffold("bare"),
        configPath,
      );

      expect(result.status).toBe("merged");
      const text = await fs.readFile(configPath, "utf-8");
      expect(text).toContain(`storage: vercelBlobStorage({
    token: secret("HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN"),
  }),`);
      expect(text).not.toMatch(/access|HOT_UPDATER_VERCEL_BLOB_ACCESS/u);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

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
          updateStrategy: "fingerprint", // or "appVersion"
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
