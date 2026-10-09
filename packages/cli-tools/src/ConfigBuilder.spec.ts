import { describe, expect, it } from "vitest";

import { ConfigBuilder, type ProviderConfig } from "./ConfigBuilder";

const testBuildConfig = (name: string): ProviderConfig => ({
  imports: [{ pkg: `@hot-updater/${name}`, named: [name] }],
  configString: name === "bare" ? "bare({ enableHermes: true })" : `${name}()`,
});

const cloudflareStorage: ProviderConfig = {
  imports: [{ pkg: "@hot-updater/cloudflare", named: ["r2Storage"] }],
  configString: `r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    credentials: {
      accessKeyId: process.env.HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
    },
  })`,
};
const cloudflareDatabase: ProviderConfig = {
  imports: [{ pkg: "@hot-updater/cloudflare", named: ["d1Database"] }],
  configString: `d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  })`,
};
const cloudflarePlugins: ProviderConfig = {
  imports: [
    {
      pkg: "hot-updater/plugins",
      named: ["apiKeys", "insights", "remoteConfig"],
    },
  ],
  configString: "[apiKeys(), insights(), remoteConfig()]",
};

const cloudflare = (build: string) =>
  new ConfigBuilder()
    .setBuild(testBuildConfig(build))
    .setStorage(cloudflareStorage)
    .setDatabase(cloudflareDatabase)
    .setPlugins(cloudflarePlugins)
    .getScaffold();

describe("ConfigBuilder", () => {
  it("writes hot-updater.config.ts with the build and the server's storage, database, and plugins", () => {
    const scaffold = cloudflare("bare");

    expect(scaffold.pluginsConfigString).toBe(
      "[apiKeys(), insights(), remoteConfig()]",
    );
    expect(scaffold.text).toBe(`import { bare } from "@hot-updater/bare";
import { d1Database, r2Storage } from "@hot-updater/cloudflare";
import { defineConfig } from "hot-updater";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
import { existsSync } from "node:fs";

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
  }),
  database: d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),
  plugins: [apiKeys(), insights(), remoteConfig()],
  updateStrategy: "appVersion", // or "fingerprint"
});`);
  });

  it.each([
    ["rock", 'import { rock } from "@hot-updater/rock";', "build: rock(),"],
    ["expo", 'import { expo } from "@hot-updater/expo";', "build: expo(),"],
  ] as const)(
    "imports the %s build adapter",
    (build, importLine, buildLine) => {
      const { text } = cloudflare(build);

      expect(text).toContain(importLine);
      expect(text).toContain(buildLine);
    },
  );

  it("puts helpers between the environment loading and the config, with their imports", () => {
    const scaffold = new ConfigBuilder()
      .setBuild(testBuildConfig("bare"))
      .setStorage({
        imports: [{ pkg: "@hot-updater/aws", named: ["s3Storage"] }],
        configString: "s3Storage(awsOptions)",
      })
      .setDatabase({
        imports: [{ pkg: "@hot-updater/aws", named: ["dynamoDB"] }],
        configString: "dynamoDB(awsOptions)",
      })
      .setPlugins({
        imports: [
          {
            pkg: "hot-updater/plugins",
            named: ["apiKeys", "insights", "remoteConfig"],
          },
        ],
        configString: "[apiKeys(), insights(), remoteConfig()]",
      })
      .addImport({ pkg: "@aws-sdk/credential-providers", named: ["fromIni"] })
      .setIntermediateCode(
        "const awsOptions = { credentials: fromIni({ profile: 'dev' }) };",
      )
      .getScaffold();

    expect(scaffold.text)
      .toBe(`import { dynamoDB, s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { fromIni } from "@aws-sdk/credential-providers";
import { defineConfig } from "hot-updater";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";
import { existsSync } from "node:fs";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

const awsOptions = { credentials: fromIni({ profile: 'dev' }) };

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: s3Storage(awsOptions),
  database: dynamoDB(awsOptions),
  plugins: [apiKeys(), insights(), remoteConfig()],
  updateStrategy: "appVersion", // or "fingerprint"
});`);
  });

  it("writes a plugin list the config names itself", () => {
    const scaffold = new ConfigBuilder()
      .setBuild(testBuildConfig("bare"))
      .setStorage({
        imports: [{ pkg: "@hot-updater/aws", named: ["s3Storage"] }],
        configString: "s3Storage({})",
      })
      .setDatabase({
        imports: [
          { pkg: "@hot-updater/standalone", named: ["standaloneRepository"] },
        ],
        configString: `standaloneRepository({ baseUrl: "https://updates.example.com/hot-updater/admin" })`,
      })
      .setPlugins({
        imports: [
          { pkg: "hot-updater/plugins", named: ["apiKeys", "insights"] },
        ],
        configString: "[insights(), apiKeys()]",
      })
      .getScaffold();

    expect(scaffold.text).toContain(
      'import { apiKeys, insights } from "hot-updater/plugins";',
    );
    expect(scaffold.text).toContain("  plugins: [insights(), apiKeys()],\n");
  });

  it("needs the server's plugins", () => {
    expect(() =>
      new ConfigBuilder()
        .setBuild(testBuildConfig("bare"))
        .setStorage(cloudflareStorage)
        .setDatabase(cloudflareDatabase)
        .getScaffold(),
    ).toThrow("Plugins config must be set using .setPlugins()");
  });
});
