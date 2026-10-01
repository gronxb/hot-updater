import { describe, expect, it } from "vitest";

import {
  type BuildType,
  ConfigBuilder,
  type ProviderConfig,
} from "./ConfigBuilder";

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
  imports: [{ pkg: "@hot-updater/cloudflare", named: ["plugins"] }],
  configString: "plugins",
};

const cloudflare = (build: BuildType) =>
  new ConfigBuilder()
    .setBuildType(build)
    .setStorage(cloudflareStorage)
    .setDatabase(cloudflareDatabase)
    .setPlugins(cloudflarePlugins)
    .getScaffold();

describe("ConfigBuilder", () => {
  it("writes hot-updater.config.ts with the build and the server's storage, database, and plugins", () => {
    const scaffold = cloudflare("bare");

    expect(scaffold.pluginsConfigString).toBe("plugins");
    expect(scaffold.text).toBe(`import { bare } from "@hot-updater/bare";
import { d1Database, plugins, r2Storage } from "@hot-updater/cloudflare";
import { defineConfig } from "hot-updater";
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
  plugins,
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
      .setBuildType("bare")
      .setStorage({
        imports: [{ pkg: "@hot-updater/aws", named: ["s3Storage"] }],
        configString: "s3Storage(awsOptions)",
      })
      .setDatabase({
        imports: [{ pkg: "@hot-updater/aws", named: ["dynamoDB"] }],
        configString: "dynamoDB(awsOptions)",
      })
      .setPlugins({
        imports: [{ pkg: "@hot-updater/aws", named: ["plugins"] }],
        configString: "plugins",
      })
      .addImport({ pkg: "@aws-sdk/credential-providers", named: ["fromIni"] })
      .setIntermediateCode(
        "const awsOptions = { credentials: fromIni({ profile: 'dev' }) };",
      )
      .getScaffold();

    expect(scaffold.text)
      .toBe(`import { dynamoDB, plugins, s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { fromIni } from "@aws-sdk/credential-providers";
import { defineConfig } from "hot-updater";
import { existsSync } from "node:fs";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

const awsOptions = { credentials: fromIni({ profile: 'dev' }) };

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: s3Storage(awsOptions),
  database: dynamoDB(awsOptions),
  plugins,
  updateStrategy: "appVersion", // or "fingerprint"
});`);
  });

  it("writes a plugin list the config names itself", () => {
    const scaffold = new ConfigBuilder()
      .setBuildType("bare")
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
          { pkg: "@hot-updater/server/plugins/api-keys", named: ["apiKeys"] },
          { pkg: "@hot-updater/server/plugins/insights", named: ["insights"] },
        ],
        configString: "[insights(), apiKeys()]",
      })
      .getScaffold();

    expect(scaffold.text).toContain(
      'import { apiKeys } from "@hot-updater/server/plugins/api-keys";',
    );
    expect(scaffold.text).toContain("  plugins: [insights(), apiKeys()],\n");
  });

  it("needs the server's plugins", () => {
    expect(() =>
      new ConfigBuilder()
        .setBuildType("bare")
        .setStorage(cloudflareStorage)
        .setDatabase(cloudflareDatabase)
        .getScaffold(),
    ).toThrow("Plugins config must be set using .setPlugins()");
  });
});
