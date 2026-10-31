import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { secret, writeHotUpdaterConfig } from "@hot-updater/cli-tools";
import { afterEach, describe, expect, it } from "vitest";

import { getConfigScaffold } from "./configTemplate";
import { initProvider } from "./init/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

const configWith = async (text: string) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-cloudflare-config-"),
  );
  tempDirs.push(dir);
  const configPath = path.join(dir, "hot-updater.config.ts");
  await fs.writeFile(configPath, text, "utf8");
  return configPath;
};

const RESOURCES = {
  accountId: "account-id",
  bucketName: "bundles",
  d1DatabaseId: "database-id",
};

/** The config init of 1.1 wrote, with a team store and a base path of the project's own. */
const CONFIG_1_1 = `import { bare } from "@hot-updater/bare";
import { d1Database, r2Storage } from "@hot-updater/cloudflare";
import { defineConfig } from "hot-updater";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
import { existsSync } from "node:fs";

import { teamStore } from "./secrets/teamStore";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    credentials: {
      accessKeyId: process.env.HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
    },
    basePath: "ota",
  }),
  database: d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),
  plugins: [apiKeys(), insights(), remoteConfig()],
  secrets: teamStore(),
  updateStrategy: "fingerprint",
});
`;

describe("Cloudflare config scaffold", () => {
  it("names the resources init set up and reads the token and R2 keys with secret()", () => {
    expect(getConfigScaffold("bare", RESOURCES).text).toMatchInlineSnapshot(`
      "import { bare } from "@hot-updater/bare";
      import { d1Database, r2Storage } from "@hot-updater/cloudflare";
      import { defineConfig, localSecrets, secret } from "hot-updater";
      import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
      import { existsSync } from "node:fs";

      if (existsSync(".env.hotupdater")) {
        process.loadEnvFile(".env.hotupdater");
      }

      export default defineConfig({
        build: bare({ enableHermes: true }),
        storage: r2Storage({
          bucketName: "bundles",
          accountId: "account-id",
          credentials: {
            accessKeyId: secret("HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID"),
            secretAccessKey: secret("HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
          },
        }),
        database: d1Database({
          databaseId: "database-id",
          accountId: "account-id",
          cloudflareApiToken: secret("HOT_UPDATER_CLOUDFLARE_API_TOKEN"),
        }),
        plugins: [apiKeys(), insights(), remoteConfig()],
        secrets: localSecrets(),
        updateStrategy: "appVersion", // or "fingerprint"
      });"
    `);
  });

  it("reads the same credentials init stores in a team store", () => {
    const { text } = getConfigScaffold("bare", RESOURCES);
    const names = [
      ...new Set(
        [...text.matchAll(/secret\("([^"]+)"\)/gu)].map(([, name]) => name!),
      ),
    ].sort();

    expect(names).toEqual([...initProvider.secrets].sort());
  });

  it("reads every credential with secret(), in init's config and the agent scaffold's", () => {
    for (const { text } of [
      getConfigScaffold("bare", RESOURCES),
      getConfigScaffold("bare"),
    ]) {
      expect(text).not.toMatch(/secretEnv|"secret:/u);
      for (const name of initProvider.secrets) {
        expect(text).toContain(`secret("${name}")`);
        expect(text).not.toContain(`process.env.${name}`);
      }
    }
  });

  it("reads the IDs the agent records from the environment for the agent scaffold", () => {
    expect(getConfigScaffold("bare").text).toContain(
      "databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,",
    );
  });

  it("moves a 1.1 config to secret() when init runs again, keeping the project's own settings", async () => {
    const configPath = await configWith(CONFIG_1_1);

    await writeHotUpdaterConfig(
      getConfigScaffold("bare", RESOURCES),
      configPath,
    );

    expect(await fs.readFile(configPath, "utf8")).toMatchInlineSnapshot(`
      "import { existsSync } from "node:fs";
      import { teamStore } from "./secrets/teamStore";
      import { bare } from "@hot-updater/bare";
      import { d1Database, r2Storage } from "@hot-updater/cloudflare";
      import { defineConfig, secret } from "hot-updater";
      import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";

      if (existsSync(".env.hotupdater")) {
        process.loadEnvFile(".env.hotupdater");
      }

      export default defineConfig({
        build: bare({ enableHermes: true }),
        storage: r2Storage({
          bucketName: "bundles",
          accountId: "account-id",
          credentials: {
            accessKeyId: secret("HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID"),
            secretAccessKey: secret("HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
          },
          basePath: "ota",
        }),
        database: d1Database({
          databaseId: "database-id",
          accountId: "account-id",
          cloudflareApiToken: secret("HOT_UPDATER_CLOUDFLARE_API_TOKEN"),
        }),
        plugins: [apiKeys(), insights(), remoteConfig()],
        secrets: teamStore(),
        updateStrategy: "fingerprint",
      });
      "
    `);
  });

  it("takes the resources a later init chose", async () => {
    const configPath = await configWith(
      `${getConfigScaffold("bare", RESOURCES).text}\n`,
    );

    await writeHotUpdaterConfig(
      getConfigScaffold("bare", { ...RESOURCES, d1DatabaseId: "new-database" }),
      configPath,
    );

    const text = await fs.readFile(configPath, "utf8");
    expect(text).toContain('databaseId: "new-database",');
    expect(text).not.toContain("database-id");
    expect(text.match(/from "hot-updater";/gu)).toHaveLength(1);
    expect(text).toContain(
      'import { defineConfig, localSecrets, secret } from "hot-updater";',
    );
  });

  it("moves an earlier 1.2 config's secretEnv helpers to secret() when init runs again", async () => {
    const configPath =
      await configWith(`import { bare } from "@hot-updater/bare";
import { d1Database, r2Storage } from "@hot-updater/cloudflare";
import { defineConfig, localSecrets, secretEnv } from "hot-updater";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
import { existsSync } from "node:fs";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

const storageSecrets = secretEnv([
  "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
  "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
]);

const databaseSecrets = secretEnv([
  "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
]);

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: r2Storage({
    bucketName: "bundles",
    accountId: "account-id",
    credentials: async () => {
      const env = await storageSecrets();
      return {
        accessKeyId: env.HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID,
        secretAccessKey: env.HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      };
    },
  }),
  database: d1Database({
    databaseId: "database-id",
    accountId: "account-id",
    cloudflareApiToken: async () =>
      (await databaseSecrets()).HOT_UPDATER_CLOUDFLARE_API_TOKEN,
  }),
  plugins: [apiKeys(), insights(), remoteConfig()],
  secrets: localSecrets(),
  updateStrategy: "appVersion",
});
`);

    await writeHotUpdaterConfig(
      getConfigScaffold("bare", RESOURCES),
      configPath,
    );

    const text = await fs.readFile(configPath, "utf8");
    expect(text).not.toContain("secretEnv");
    expect(text).not.toContain("storageSecrets");
    expect(text).not.toContain("databaseSecrets");
    expect(text).toContain(
      'import { defineConfig, localSecrets, secret } from "hot-updater";',
    );
    expect(text.match(/from "hot-updater";/gu)).toHaveLength(1);
    expect(text).toContain(
      'cloudflareApiToken: secret("HOT_UPDATER_CLOUDFLARE_API_TOKEN"),',
    );
  });

  it("names secrets secret() takes", () => {
    expect(() =>
      initProvider.secrets.map((name) => secret(name)),
    ).not.toThrow();
  });
});
