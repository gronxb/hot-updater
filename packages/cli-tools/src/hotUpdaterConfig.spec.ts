import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it } from "vitest";

import type { BuildType, ProviderConfig } from "./ConfigBuilder";
import {
  createHotUpdaterConfigScaffold,
  writeHotUpdaterConfig,
  type ManagedHelperStatement,
} from "./hotUpdaterConfig";

const tempDirs: string[] = [];

const createSupabaseScaffold = (build: BuildType) => {
  const storage: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseStorage"] }],
    configString: `supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  })`,
  };
  const database: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseDatabase"] }],
    configString: `supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
  })`,
  };

  return createHotUpdaterConfigScaffold({
    build,
    storage,
    database,
  });
};

const createAwsScaffold = (
  build: BuildType,
  { profile }: { profile: string | null },
) => {
  const storage: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/aws", named: ["s3Storage"] }],
    configString: "s3Storage(commonOptions)",
  };
  const database: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/aws", named: ["s3Database"] }],
    configString: `s3Database({
    ...commonOptions,
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  })`,
  };

  const helperStatements: ManagedHelperStatement[] = profile
    ? [
        {
          name: "commonOptions",
          strategy: "merge-object",
          code: `const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};`,
        },
      ]
    : [
        {
          name: "commonOptions",
          strategy: "merge-object",
          code: `const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
  },
};`,
        },
      ];

  return createHotUpdaterConfigScaffold({
    build,
    storage,
    database,
    helperStatements,
    extraImports: profile
      ? [
          {
            pkg: "@aws-sdk/credential-provider-sso",
            named: ["fromSSO"],
          },
        ]
      : [],
  });
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("writeHotUpdaterConfig", () => {
  it("creates a new config file when one does not exist", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-config-create-"),
    );
    tempDirs.push(tempDir);
    const configPath = path.join(tempDir, "hot-updater.config.ts");
    const scaffold = createSupabaseScaffold("bare");

    const result = await writeHotUpdaterConfig(scaffold, configPath);

    expect(result.status).toBe("created");
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(
      `${scaffold.text}\n`,
    );
  });

  it("merges managed provider fields while preserving existing supabase values", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-config-supabase-"),
    );
    tempDirs.push(tempDir);
    const configPath = path.join(tempDir, "hot-updater.config.ts");

    await fs.writeFile(
      configPath,
      `import { bare } from "@hot-updater/bare";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: supabaseStorage({
    supabaseUrl: process.env.CUSTOM_SUPABASE_URL!,
    customNested: {
      preserveMe: true,
    },
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.CUSTOM_SUPABASE_URL!,
  }),
});
`,
      "utf-8",
    );

    const result = await writeHotUpdaterConfig(
      createSupabaseScaffold("bare"),
      configPath,
    );
    const updatedConfig = await fs.readFile(configPath, "utf-8");

    expect(result.status).toBe("merged");
    expect(updatedConfig).toContain("supabaseUrl: process.env.CUSTOM_SUPABASE_URL!");
    expect(updatedConfig).toContain("preserveMe: true");
    expect(updatedConfig).toContain(
      "supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!",
    );
    expect(updatedConfig).toContain(
      "bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!",
    );
    expect(updatedConfig).not.toContain('updateStrategy: "appVersion"');
  });

  it("replaces provider-managed AWS sections when switching to Supabase and keeps unrelated fields", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-config-provider-switch-"),
    );
    tempDirs.push(tempDir);
    const configPath = path.join(tempDir, "hot-updater.config.ts");

    await fs.writeFile(
      configPath,
      `import { s3Database, s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

const commonOptions = {
  bucketName: process.env.CUSTOM_BUCKET_NAME!,
  region: process.env.CUSTOM_REGION!,
  credentials: {
    accessKeyId: process.env.CUSTOM_ACCESS_KEY_ID!,
    secretAccessKey: process.env.CUSTOM_SECRET_ACCESS_KEY!,
  },
};

export default defineConfig({
  nativeBuild: {
    android: {
      releaseApk: {
        packageName: "com.example.app",
      },
    },
  },
  build: bare({ enableHermes: true }),
  storage: s3Storage(commonOptions),
  database: s3Database({
    ...commonOptions,
  }),
  signing: {
    enabled: true,
    privateKeyPath: "./keys/private-key.pem",
  },
});
`,
      "utf-8",
    );

    const result = await writeHotUpdaterConfig(
      createSupabaseScaffold("bare"),
      configPath,
    );
    const updatedConfig = await fs.readFile(configPath, "utf-8");

    expect(result.status).toBe("merged");
    expect(updatedConfig).toContain("supabaseStorage({");
    expect(updatedConfig).toContain("supabaseDatabase({");
    expect(updatedConfig).not.toContain("s3Storage(");
    expect(updatedConfig).not.toContain("s3Database(");
    expect(updatedConfig).not.toContain("commonOptions");
    expect(updatedConfig).toContain('packageName: "com.example.app"');
    expect(updatedConfig).toContain('privateKeyPath: "./keys/private-key.pem"');
  });

  it("updates build plugin only when the selected build changes", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-config-build-switch-"),
    );
    tempDirs.push(tempDir);
    const configPath = path.join(tempDir, "hot-updater.config.ts");

    await fs.writeFile(
      configPath,
      `import { bare } from "@hot-updater/bare";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: supabaseStorage({
    supabaseUrl: process.env.CUSTOM_SUPABASE_URL!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.CUSTOM_SUPABASE_URL!,
  }),
  fingerprint: {
    debug: true,
  },
});
`,
      "utf-8",
    );

    const result = await writeHotUpdaterConfig(
      createSupabaseScaffold("rock"),
      configPath,
    );
    const updatedConfig = await fs.readFile(configPath, "utf-8");

    expect(result.status).toBe("merged");
    expect(updatedConfig).toContain('import { rock } from "@hot-updater/rock";');
    expect(updatedConfig).not.toContain('import { bare } from "@hot-updater/bare";');
    expect(updatedConfig).toContain("build: rock()");
    expect(updatedConfig).toContain("debug: true");
  });

  it("merges AWS helper and database fields for same-provider re-init", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-config-aws-merge-"),
    );
    tempDirs.push(tempDir);
    const configPath = path.join(tempDir, "hot-updater.config.ts");

    await fs.writeFile(
      configPath,
      `import { s3Database, s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

const commonOptions = {
  bucketName: process.env.CUSTOM_BUCKET_NAME!,
  region: process.env.CUSTOM_REGION!,
  credentials: {
    accessKeyId: process.env.CUSTOM_ACCESS_KEY_ID!,
    secretAccessKey: process.env.CUSTOM_SECRET_ACCESS_KEY!,
  },
};

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: s3Storage(commonOptions),
  database: s3Database({
    ...commonOptions,
  }),
});
`,
      "utf-8",
    );

    const result = await writeHotUpdaterConfig(
      createAwsScaffold("bare", { profile: null }),
      configPath,
    );
    const updatedConfig = await fs.readFile(configPath, "utf-8");

    expect(result.status).toBe("merged");
    expect(updatedConfig).toContain("process.env.CUSTOM_BUCKET_NAME!");
    expect(updatedConfig).toContain("process.env.CUSTOM_ACCESS_KEY_ID!");
    expect(updatedConfig).toContain(
      "cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!",
    );
  });

  it("skips unsupported dynamic config shapes", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-config-skip-"),
    );
    tempDirs.push(tempDir);
    const configPath = path.join(tempDir, "hot-updater.config.ts");
    const originalConfig = `export default defineConfig(getConfig());\n`;

    await fs.writeFile(configPath, originalConfig, "utf-8");

    const result = await writeHotUpdaterConfig(
      createSupabaseScaffold("bare"),
      configPath,
    );

    expect(result.status).toBe("skipped");
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalConfig);
  });
});
