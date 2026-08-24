import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  transformTemplate,
  writeHotUpdaterConfig,
} from "@hot-updater/cli-tools";
import { afterEach, describe, expect, it } from "vitest";

import { getConfigScaffold, SOURCE_TEMPLATE } from "./templates";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("AWS managed config scaffold", () => {
  it("renders only client-owned network options in the app bootstrap", () => {
    const source = transformTemplate(SOURCE_TEMPLATE, {
      apiKey: JSON.stringify("api-key"),
      source: JSON.stringify("https://example.cloudfront.net"),
    });

    expect(source).toContain('baseURL: "https://example.cloudfront.net"');
    expect(source).toContain('"x-api-key": "api-key"');
    expect(source).toContain("HotUpdater.init({");
    expect(source).toContain("HotUpdater.checkForUpdate");
    expect(source).not.toContain("HotUpdater.wrap");
    expect(source).toContain("return null; // Replace with your app root.");
    expect(source).not.toContain("authorityId");
    expect(source).not.toContain("YourApp");
  });

  it("renders DynamoDB as the managed metadata database", () => {
    const scaffold = getConfigScaffold(
      "bare",
      {
        mode: "local",
        profile: null,
      },
      "aws.test-authority",
    );

    expect(scaffold.text).toContain(
      'import { dynamoDB, s3Storage } from "@hot-updater/aws";',
    );
    expect(scaffold.text).toContain(
      "tableName: process.env.HOT_UPDATER_DYNAMODB_TABLE_NAME!",
    );
    expect(scaffold.text).toContain('authorityId: "aws.test-authority"');
    expect(scaffold.text).not.toContain("storageOptions");
  });

  it("re-initializes an existing DynamoDB config without duplicating helpers or replacing its env path", async () => {
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
