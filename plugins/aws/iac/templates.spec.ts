import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  writeHotUpdaterConfig,
  writeServerDefinition,
} from "@hot-updater/cli-tools";
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
  it("renders DynamoDB and S3 as the server definition's database and storage", () => {
    const scaffold = getConfigScaffold("bare", {
      mode: "local",
      profile: null,
    });

    expect(scaffold.text).not.toContain("@hot-updater/aws");
    expect(scaffold.text).toContain('server: "./hotUpdater.ts"');
    expect(scaffold.definition.text).toContain(
      'import { dynamoDB, plugins, s3Storage } from "@hot-updater/aws";',
    );
    expect(scaffold.definition.text).toContain(
      "tableName: process.env.HOT_UPDATER_DYNAMODB_TABLE_NAME!",
    );
    expect(scaffold.definition.text).not.toContain("authorityId");
    expect(scaffold.definition.text).not.toContain("catalogId");
    expect(scaffold.definition.text).not.toContain("storageOptions");
  });

  it("moves an existing DynamoDB config's storage, database, and helpers out, keeping its env path", async () => {
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

const awsOptions = {
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: s3Storage({
    ...awsOptions,
    bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
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
    expect(updated).not.toContain("awsOptions");
    expect(updated).not.toContain("fromSSO");
    expect(updated).toContain("HOT_UPDATER_E2E_ENV_TARGET_PATH");
    expect(updated.match(/server: "\.\/hotUpdater\.ts"/gu)).toHaveLength(1);
  });

  it("replaces a definition init wrote with other credentials, and keeps an edited one", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-aws-auth-switch-"),
    );
    tempDirs.push(tempDir);
    const definitionPath = path.join(tempDir, "hotUpdater.ts");
    const sso = getConfigScaffold("bare", { mode: "sso", profile: "work" });
    const local = getConfigScaffold("bare", { mode: "local", profile: null });
    await fs.writeFile(definitionPath, `${sso.definition.text}\n`, "utf8");

    await expect(
      writeServerDefinition(local, definitionPath),
    ).resolves.toMatchObject({ status: "updated" });
    const updated = await fs.readFile(definitionPath, "utf8");
    expect(updated).toContain(
      'import { fromNodeProviderChain } from "@aws-sdk/credential-providers";',
    );
    expect(updated).toContain("credentials: fromNodeProviderChain()");
    expect(updated).not.toContain("fromSSO(");

    const edited = updated.replace(
      "  plugins,\n",
      "  plugins: [...plugins],\n",
    );
    await fs.writeFile(definitionPath, edited, "utf8");
    await expect(
      writeServerDefinition(sso, definitionPath),
    ).resolves.toMatchObject({ status: "kept" });
    await expect(fs.readFile(definitionPath, "utf8")).resolves.toBe(edited);
  });

  it("renders access key credentials for account mode", () => {
    const { definition } = getConfigScaffold("bare", { mode: "account" });

    expect(definition.text).toContain(
      "accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!",
    );
    expect(definition.text).toContain(
      "secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!",
    );
    expect(definition.text).not.toContain("fromSSO(");
    expect(definition.text).not.toContain("fromIni(");
    expect(definition.text).not.toContain("fromNodeProviderChain(");
  });

  it("renders SSO credentials for sso mode", () => {
    const { definition } = getConfigScaffold("bare", {
      mode: "sso",
      profile: "default",
    });

    expect(definition.text).toContain(
      'import { fromSSO } from "@aws-sdk/credential-provider-sso";',
    );
    expect(definition.text).toContain(
      "credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! })",
    );
  });

  it("renders the default provider chain for local session mode", () => {
    const { definition } = getConfigScaffold("bare", {
      mode: "local",
      profile: null,
    });

    expect(definition.text).toContain(
      'import { fromNodeProviderChain } from "@aws-sdk/credential-providers";',
    );
    expect(definition.text).toContain("credentials: fromNodeProviderChain()");
    expect(definition.text).not.toContain("HOT_UPDATER_S3_ACCESS_KEY_ID");
  });

  it("renders a shared profile lookup for local profile mode", () => {
    const { definition } = getConfigScaffold("bare", {
      mode: "local",
      profile: "work",
    });

    expect(definition.text).toContain(
      'import { fromIni } from "@aws-sdk/credential-providers";',
    );
    expect(definition.text).toContain(
      "credentials: fromIni({ profile: process.env.HOT_UPDATER_AWS_PROFILE! })",
    );
  });
});
