import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeHotUpdaterConfig } from "@hot-updater/cli-tools";
import { afterEach, describe, expect, it } from "vitest";

import { getConfigScaffold } from "./templates";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("AWS managed config scaffold", () => {
  it("renders DynamoDB as the managed metadata database, with the managed server's plugins", () => {
    const scaffold = getConfigScaffold("bare", {
      mode: "local",
      profile: null,
    });

    expect(scaffold.text).toContain(
      'import { dynamoDB, s3Storage } from "@hot-updater/aws";',
    );
    expect(scaffold.text).toContain(
      'import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";',
    );
    expect(scaffold.text).toContain(
      "tableName: process.env.HOT_UPDATER_DYNAMODB_TABLE_NAME!",
    );
    expect(scaffold.text).toContain(
      "\n  plugins: [apiKeys(), insights(), remoteConfig()],\n",
    );
    // The managed server runs in AWS: the config names no server code.
    expect(scaffold.text).not.toContain("@hot-updater/server");
    expect(scaffold.text).not.toContain("server:");
    expect(scaffold.text).not.toContain("authorityId");
    expect(scaffold.text).not.toContain("catalogId");
    expect(scaffold.text).not.toContain("storageOptions");
  });

  it("re-initializes an existing DynamoDB config without duplicating helpers or replacing its env path, and adds the plugins once", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-aws-config-reinit-"),
    );
    tempDirs.push(tempDir);
    const configPath = path.join(tempDir, "hot-updater.config.ts");
    await fs.writeFile(
      configPath,
      `import { fromSSO } from "@aws-sdk/credential-provider-sso";
import { dynamoDB, s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({
  path: process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH ?? ".env.hotupdater",
});

const providerNamespace = process.env.HOT_UPDATER_E2E_PROVIDER_NAMESPACE;
const awsOptions = {
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: s3Storage({
    ...awsOptions,
    bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
    basePath: providerNamespace,
  }),
  database: dynamoDB({
    ...awsOptions,
    tableName: process.env.HOT_UPDATER_DYNAMODB_TABLE_NAME!,
  }),
});
`,
      "utf8",
    );
    const scaffold = getConfigScaffold("bare", {
      mode: "sso",
      profile: "hot-updater",
    });

    await writeHotUpdaterConfig(scaffold, configPath);
    await writeHotUpdaterConfig(scaffold, configPath);

    const updated = await fs.readFile(configPath, "utf8");
    expect(updated.match(/const awsOptions\s*=/gu)).toHaveLength(1);
    expect(updated).not.toContain("const storageOptions");
    expect(updated).toContain("HOT_UPDATER_E2E_ENV_TARGET_PATH");
    expect(updated).toContain("basePath: providerNamespace");
    expect(updated).toContain(
      'import { dynamoDB, s3Storage } from "@hot-updater/aws";',
    );
    expect(updated).toContain(
      'import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";',
    );
    expect(
      updated.match(
        /^\s*plugins: \[apiKeys\(\), insights\(\), remoteConfig\(\)\],$/gmu,
      ),
    ).toHaveLength(1);
  });

  it("moves a config v0 init wrote to DynamoDB, with storage off v0's commonOptions", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-aws-config-v0-"),
    );
    tempDirs.push(tempDir);
    const configPath = path.join(tempDir, "hot-updater.config.ts");
    await fs.writeFile(
      configPath,
      `import { existsSync } from "node:fs";
import { bare } from "@hot-updater/bare";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { s3Storage, s3Database } from "@hot-updater/aws";
import { defineConfig } from "hot-updater";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromNodeProviderChain(),
};

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: s3Storage(commonOptions),
  database: s3Database({
    ...commonOptions,
    // prettier-ignore
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  }),
  updateStrategy: "appVersion",
});
`,
      "utf8",
    );
    const scaffold = getConfigScaffold("bare", {
      mode: "local",
      profile: null,
    });

    const result = await writeHotUpdaterConfig(scaffold, configPath);
    const updated = await fs.readFile(configPath, "utf8");

    expect(result.status).toBe("merged");
    expect(updated).not.toContain("commonOptions");
    expect(updated).not.toContain("s3Database");
    expect(updated).toContain(`  storage: s3Storage({
    ...awsOptions,
    bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  }),
  database: dynamoDB({
    ...awsOptions,
    tableName: process.env.HOT_UPDATER_DYNAMODB_TABLE_NAME!,
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  }),`);
    expect(updated).toContain("credentials: fromNodeProviderChain()");

    await writeHotUpdaterConfig(scaffold, configPath);
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(updated);
  });

  it("replaces stale credentials when the authentication mode changes", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-aws-auth-switch-"),
    );
    tempDirs.push(tempDir);
    const configPath = path.join(tempDir, "hot-updater.config.ts");
    await fs.writeFile(
      configPath,
      `${
        getConfigScaffold("bare", {
          mode: "sso",
          profile: "hot-updater",
        }).text
      }\n`,
      "utf8",
    );

    await writeHotUpdaterConfig(
      getConfigScaffold("bare", { mode: "local", profile: null }),
      configPath,
    );

    const updated = await fs.readFile(configPath, "utf8");
    expect(updated).toContain(
      'import { fromNodeProviderChain } from "@aws-sdk/credential-providers";',
    );
    expect(updated).toContain("credentials: fromNodeProviderChain()");
    expect(updated).not.toContain("fromSSO(");
  });

  it("renders access key credentials for account mode", () => {
    const scaffold = getConfigScaffold("bare", { mode: "account" });

    expect(scaffold.text).toContain(
      "accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!",
    );
    expect(scaffold.text).toContain(
      "secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!",
    );
    expect(scaffold.text).not.toContain("fromSSO(");
    expect(scaffold.text).not.toContain("fromIni(");
    expect(scaffold.text).not.toContain("fromNodeProviderChain(");
  });

  it("renders SSO credentials for sso mode", () => {
    const scaffold = getConfigScaffold("bare", {
      mode: "sso",
      profile: "default",
    });

    expect(scaffold.text).toContain(
      'import { fromSSO } from "@aws-sdk/credential-provider-sso";',
    );
    expect(scaffold.text).toContain(
      "credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! })",
    );
  });

  it("renders the default provider chain for local session mode", () => {
    const scaffold = getConfigScaffold("bare", {
      mode: "local",
      profile: null,
    });

    expect(scaffold.text).toContain(
      'import { fromNodeProviderChain } from "@aws-sdk/credential-providers";',
    );
    expect(scaffold.text).toContain("credentials: fromNodeProviderChain()");
    expect(scaffold.text).not.toContain("HOT_UPDATER_S3_ACCESS_KEY_ID");
  });

  it("renders a shared profile lookup for local profile mode", () => {
    const scaffold = getConfigScaffold("bare", {
      mode: "local",
      profile: "work",
    });

    expect(scaffold.text).toContain(
      'import { fromIni } from "@aws-sdk/credential-providers";',
    );
    expect(scaffold.text).toContain(
      "credentials: fromIni({ profile: process.env.HOT_UPDATER_AWS_PROFILE! })",
    );
  });
});
