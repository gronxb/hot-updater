import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { type BuildType, ConfigBuilder } from "./ConfigBuilder";
import {
  createHotUpdaterConfigScaffoldFromBuilder,
  readServerDefinitionStatus,
  writeHotUpdaterConfig,
  writeServerDefinition,
} from "./hotUpdaterConfig";

const tempDirs: string[] = [];

const createTempDir = async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-config-"),
  );
  tempDirs.push(tempDir);
  return tempDir;
};

const createSupabaseScaffold = (build: BuildType) =>
  createHotUpdaterConfigScaffoldFromBuilder(
    new ConfigBuilder()
      .setBuildType(build)
      .setStorage({
        imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseStorage"] }],
        configString: `supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  })`,
      })
      .setDatabase({
        imports: [
          { pkg: "@hot-updater/supabase", named: ["supabaseDatabase"] },
        ],
        configString: `supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
  })`,
      })
      .setPlugins({
        imports: [{ pkg: "@hot-updater/supabase", named: ["plugins"] }],
        configString: "plugins",
      }),
  );

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("writeHotUpdaterConfig", () => {
  it("creates a config that points at the server definition", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    const scaffold = createSupabaseScaffold("bare");

    const result = await writeHotUpdaterConfig(scaffold, configPath);

    expect(result).toEqual({
      status: "created",
      path: configPath,
      server: "./hotUpdater.ts",
    });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(
      `${scaffold.text}\n`,
    );
  });

  it("moves an older config's storage, database, and their helpers out, keeping the rest", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    await fs.writeFile(
      configPath,
      `import { applicationDefault } from "firebase-admin/app";
import { dynamoDB, s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

const customSetting = process.env.CUSTOM_SETTING;

const commonOptions = {
  bucketName: process.env.CUSTOM_BUCKET_NAME!,
  region: process.env.CUSTOM_REGION!,
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
  database: dynamoDB({
    ...commonOptions,
  }),
  signing: {
    enabled: true,
    privateKeyPath: "./keys/private-key.pem",
  },
} satisfies Parameters<typeof defineConfig>[0]);
`,
      "utf-8",
    );

    const result = await writeHotUpdaterConfig(
      createSupabaseScaffold("bare"),
      configPath,
    );
    const updatedConfig = await fs.readFile(configPath, "utf-8");

    expect(result).toMatchObject({
      status: "merged",
      server: "./hotUpdater.ts",
    });
    expect(updatedConfig).toContain('server: "./hotUpdater.ts",');
    for (const moved of [
      "storage:",
      "database:",
      "s3Storage",
      "dynamoDB",
      "commonOptions",
      "applicationDefault",
      "@hot-updater/aws",
      "@hot-updater/supabase",
    ]) {
      expect(updatedConfig).not.toContain(moved);
    }
    expect(updatedConfig).toContain("customSetting");
    expect(updatedConfig).toContain('config({ path: ".env.hotupdater" });');
    expect(updatedConfig).toContain('packageName: "com.example.app"');
    expect(updatedConfig).toContain('privateKeyPath: "./keys/private-key.pem"');
    expect(updatedConfig).toContain(
      "satisfies Parameters<typeof defineConfig>[0]",
    );
    expect(updatedConfig).not.toMatch(/\n{3,}/);

    await writeHotUpdaterConfig(createSupabaseScaffold("bare"), configPath);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(updatedConfig);
  });

  it("keeps the server the config already points at", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    await fs.writeFile(
      configPath,
      `import { bare } from "@hot-updater/bare";
import { defineConfig } from "hot-updater";

export default defineConfig({
  build: bare({ enableHermes: true }),
  server: "./servers/supabase.ts",
  updateStrategy: "appVersion",
});
`,
      "utf-8",
    );

    const result = await writeHotUpdaterConfig(
      createSupabaseScaffold("bare"),
      configPath,
    );

    expect(result).toMatchObject({
      status: "merged",
      server: "./servers/supabase.ts",
    });
    const updatedConfig = await fs.readFile(configPath, "utf-8");
    expect(updatedConfig).toContain('server: "./servers/supabase.ts",');
    expect(updatedConfig).not.toContain("./hotUpdater.ts");
  });

  it("updates the build adapter only when the selected build changes", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    await fs.writeFile(
      configPath,
      `import { bare } from "@hot-updater/bare";
import { defineConfig } from "hot-updater";

export default defineConfig({
  build: bare({ enableHermes: true }),
  server: "./hotUpdater.ts",
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
    expect(updatedConfig).toContain(
      'import { rock } from "@hot-updater/rock";',
    );
    expect(updatedConfig).not.toContain(
      'import { bare } from "@hot-updater/bare";',
    );
    expect(updatedConfig).toContain("build: rock()");
    expect(updatedConfig).toContain("debug: true");
  });

  it("skips unsupported dynamic config shapes", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    const originalConfig = `export default defineConfig(getConfig());\n`;
    await fs.writeFile(configPath, originalConfig, "utf-8");

    const result = await writeHotUpdaterConfig(
      createSupabaseScaffold("bare"),
      configPath,
    );

    expect(result.status).toBe("skipped");
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(
      originalConfig,
    );
  });
});

describe("writeServerDefinition", () => {
  it("writes the definition when it is missing, and never overwrites the project's own", async () => {
    const definitionPath = path.join(
      await createTempDir(),
      "servers",
      "hotUpdater.ts",
    );
    const scaffold = createSupabaseScaffold("bare");

    await expect(
      readServerDefinitionStatus(scaffold, definitionPath),
    ).resolves.toBe("missing");
    await expect(
      writeServerDefinition(scaffold, definitionPath),
    ).resolves.toEqual({ status: "created", path: definitionPath });
    await expect(fs.readFile(definitionPath, "utf-8")).resolves.toBe(
      `${scaffold.definition.text}\n`,
    );
    await expect(
      writeServerDefinition(scaffold, definitionPath),
    ).resolves.toEqual({ status: "unchanged", path: definitionPath });

    const edited = scaffold.definition.text.replace(
      "  plugins,\n",
      "  plugins: [...plugins, notes()],\n",
    );
    await fs.writeFile(definitionPath, edited, "utf-8");

    await expect(
      readServerDefinitionStatus(scaffold, definitionPath),
    ).resolves.toBe("edited");
    await expect(
      writeServerDefinition(scaffold, definitionPath),
    ).resolves.toEqual({ status: "kept", path: definitionPath });
    await expect(fs.readFile(definitionPath, "utf-8")).resolves.toBe(edited);
  });
});
