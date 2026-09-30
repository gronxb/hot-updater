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
  })`,
};
const cloudflareDatabase: ProviderConfig = {
  imports: [{ pkg: "@hot-updater/cloudflare", named: ["d1Database"] }],
  configString: `d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
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
  it("writes hot-updater.config.ts with the build and a pointer to the server definition", () => {
    const scaffold = cloudflare("bare");

    expect(scaffold.server).toBe("./hotUpdater.ts");
    expect(scaffold.text).toBe(`import { bare } from "@hot-updater/bare";
import { defineConfig } from "hot-updater";
import { existsSync } from "node:fs";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

export default defineConfig({
  build: bare({ enableHermes: true }),
  server: "./hotUpdater.ts",
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
      expect(text).not.toContain("@hot-updater/cloudflare");
    },
  );

  it("writes the server definition with the provider's database, storage, and plugins", () => {
    expect(cloudflare("bare").definition.text)
      .toBe(`import { d1Database, plugins, r2Storage } from "@hot-updater/cloudflare";
import { createHotUpdater } from "@hot-updater/server";

/**
 * The Hot Updater server: its database, storage, and plugins.
 * hot-updater.config.ts points the CLI and the console here.
 */
export const hotUpdater = createHotUpdater({
  database: d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
  }),
  storage: [
    r2Storage({
      bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
      accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    }),
  ],
  plugins,
});`);
  });

  it("puts helpers and their imports in the server definition", () => {
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
        configString: "[...plugins]",
      })
      .addImport({ pkg: "@aws-sdk/credential-providers", named: ["fromIni"] })
      .setIntermediateCode(
        "const awsOptions = { credentials: fromIni({ profile: 'dev' }) };",
      )
      .getScaffold();

    expect(scaffold.text).not.toContain("awsOptions");
    expect(scaffold.definition.text)
      .toBe(`import { dynamoDB, plugins, s3Storage } from "@hot-updater/aws";
import { createHotUpdater } from "@hot-updater/server";
import { fromIni } from "@aws-sdk/credential-providers";

const awsOptions = { credentials: fromIni({ profile: 'dev' }) };

/**
 * The Hot Updater server: its database, storage, and plugins.
 * hot-updater.config.ts points the CLI and the console here.
 */
export const hotUpdater = createHotUpdater({
  database: dynamoDB(awsOptions),
  storage: [
    s3Storage(awsOptions),
  ],
  plugins: [...plugins],
});`);
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
