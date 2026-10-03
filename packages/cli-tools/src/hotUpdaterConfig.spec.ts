import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigBuilder, type ProviderConfig } from "./ConfigBuilder";
import {
  createHotUpdaterConfigScaffoldFromBuilder,
  type ManagedHelperStatement,
  writeHotUpdaterConfig,
  writeHotUpdaterFiles,
} from "./hotUpdaterConfig";
import { p } from "./prompts";

type TestBuildName = "bare" | "rock";

const testBuildConfig = (name: TestBuildName): ProviderConfig => ({
  imports: [{ pkg: `@hot-updater/${name}`, named: [name] }],
  configString: name === "bare" ? "bare({ enableHermes: true })" : "rock()",
});

const tempDirs: string[] = [];

const createTempDir = async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-config-"),
  );
  tempDirs.push(tempDir);
  return tempDir;
};

const createSupabaseScaffold = (build: TestBuildName) => {
  const storage: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseStorage"] }],
    configString: `supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  })`,
  };
  const database: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseDatabase"] }],
    configString: `supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
  })`,
  };

  return createHotUpdaterConfigScaffoldFromBuilder(
    new ConfigBuilder()
      .setBuild(testBuildConfig(build))
      .setStorage(storage)
      .setDatabase(database)
      .setPlugins({
        imports: [{ pkg: "@hot-updater/supabase", named: ["plugins"] }],
        configString: "plugins",
      }),
  );
};

const createAwsScaffold = (
  build: TestBuildName,
  { profile }: { profile: string | null },
) => {
  const storage: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/aws", named: ["s3Storage"] }],
    configString: "s3Storage(commonOptions)",
  };
  const database: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/aws", named: ["dynamoDB"] }],
    configString: `dynamoDB({
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

  const builder = new ConfigBuilder()
    .setBuild(testBuildConfig(build))
    .setStorage(storage)
    .setDatabase(database)
    .setPlugins({
      imports: [{ pkg: "@hot-updater/aws", named: ["plugins"] }],
      configString: "plugins",
    })
    .setIntermediateCode(
      helperStatements.map((statement) => statement.code.trim()).join("\n\n"),
    );

  if (profile) {
    builder.addImport({
      pkg: "@aws-sdk/credential-provider-sso",
      named: ["fromSSO"],
    });
  }

  return createHotUpdaterConfigScaffoldFromBuilder(builder, {
    helperStatements,
  });
};

const createFirebaseScaffold = (build: TestBuildName) => {
  const helperStatements: ManagedHelperStatement[] = [
    {
      name: "credential",
      strategy: "preserve-existing",
      code: "const credential = applicationDefault();",
    },
  ];
  const builder = new ConfigBuilder()
    .setBuild(testBuildConfig(build))
    .setStorage({
      imports: [{ pkg: "@hot-updater/firebase", named: ["firebaseStorage"] }],
      configString: `firebaseStorage({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
    credential,
  })`,
    })
    .setDatabase({
      imports: [{ pkg: "@hot-updater/firebase", named: ["firebaseDatabase"] }],
      configString: `firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    credential,
  })`,
    })
    .setPlugins({
      imports: [{ pkg: "@hot-updater/firebase", named: ["plugins"] }],
      configString: "plugins",
    })
    .addImport({ pkg: "firebase-admin/app", named: ["applicationDefault"] })
    .setIntermediateCode(helperStatements[0]!.code);
  return createHotUpdaterConfigScaffoldFromBuilder(builder, {
    helperStatements,
  });
};

/** A Firebase config whose own credential reads a service account with cert. */
const FIREBASE_CERT_CONFIG = `import { bare } from "@hot-updater/bare";
import { firebaseDatabase, firebaseStorage, plugins } from "@hot-updater/firebase";
import { cert } from "firebase-admin/app";
import { defineConfig } from "hot-updater";
import { existsSync } from "node:fs";

if (existsSync(".env.hotupdater")) {
  process.loadEnvFile(".env.hotupdater");
}

const credential = cert(process.env.SERVICE_ACCOUNT_PATH!);

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: firebaseStorage({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
    credential,
  }),
  database: firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    credential,
  }),
  plugins,
});
`;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("writeHotUpdaterConfig", () => {
  it("creates and updates config without a user-managed Catalog identity", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );

    await writeHotUpdaterConfig(createSupabaseScaffold("bare"), configPath);
    await writeHotUpdaterConfig(createSupabaseScaffold("bare"), configPath);

    const config = await fs.readFile(configPath, "utf-8");
    expect(config).not.toContain("authorityId");
    expect(config).not.toContain("catalogId");
  });

  it("creates a new config file when one does not exist", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    const scaffold = createSupabaseScaffold("bare");

    const result = await writeHotUpdaterConfig(scaffold, configPath);

    expect(result).toEqual({ status: "created", path: configPath });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(
      `${scaffold.text}\n`,
    );
  });

  it("merges managed provider fields through a satisfies wrapper while preserving existing values", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
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
} satisfies Parameters<typeof defineConfig>[0]);
`,
      "utf-8",
    );

    const result = await writeHotUpdaterConfig(
      createSupabaseScaffold("bare"),
      configPath,
    );
    const updatedConfig = await fs.readFile(configPath, "utf-8");

    expect(result.status).toBe("merged");
    expect(updatedConfig).toContain(
      "satisfies Parameters<typeof defineConfig>[0]",
    );
    expect(updatedConfig).toContain(
      "supabaseUrl: process.env.CUSTOM_SUPABASE_URL!",
    );
    expect(updatedConfig).toContain("preserveMe: true");
    expect(updatedConfig).toContain(
      "supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!",
    );
    expect(updatedConfig).toContain(
      "bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!",
    );
    expect(updatedConfig).toContain(
      'import { plugins, supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";',
    );
    expect(updatedConfig).toContain("  plugins,\n}");
    expect(updatedConfig).not.toContain('updateStrategy: "appVersion"');
  });

  it("replaces provider-managed AWS sections when switching to Supabase and keeps unrelated fields", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    await fs.writeFile(
      configPath,
      `import { applicationDefault } from "firebase-admin/app";
import { dynamoDB, plugins, s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

const customSetting = process.env.CUSTOM_SETTING;

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
  database: dynamoDB({
    ...commonOptions,
  }),
  plugins,
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
    expect(updatedConfig).not.toContain("dynamoDB(");
    expect(updatedConfig).not.toContain("@hot-updater/aws");
    expect(updatedConfig).not.toContain("commonOptions");
    expect(updatedConfig).not.toContain("applicationDefault");
    expect(updatedConfig.match(/\bplugins\b/gu)).toHaveLength(2);
    expect(updatedConfig).toContain("customSetting");
    expect(updatedConfig).toContain('packageName: "com.example.app"');
    expect(updatedConfig).toContain('privateKeyPath: "./keys/private-key.pem"');
    expect(updatedConfig).toContain("enabled: true");
    expect(updatedConfig).not.toMatch(/\n{3,}/);

    await writeHotUpdaterConfig(createSupabaseScaffold("bare"), configPath);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(updatedConfig);
  });

  it("lists the server's plugins: added after a config's last setting, and replacing a list that differs", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    const scaffold = createSupabaseScaffold("bare");
    // As rc.20's init wrote it, beside hotUpdater.plugins.ts.
    await fs.writeFile(
      configPath,
      `${scaffold.text.replace("  plugins,\n", "")}\n`,
      "utf-8",
    );

    await writeHotUpdaterConfig(scaffold, configPath);
    const added = await fs.readFile(configPath, "utf-8");
    expect(added).toContain(
      '  updateStrategy: "appVersion", // or "fingerprint"\n  plugins,\n});',
    );
    expect(added).toContain(
      'import { plugins, supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";',
    );
    await writeHotUpdaterConfig(scaffold, configPath);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(added);

    await fs.writeFile(
      configPath,
      `${scaffold.text.replace("  plugins,\n", "  plugins: [...plugins, notes()],\n")}\n`,
      "utf-8",
    );
    await writeHotUpdaterConfig(scaffold, configPath);
    const replaced = await fs.readFile(configPath, "utf-8");
    expect(replaced).toContain(
      '  }),\n  plugins,\n  updateStrategy: "appVersion", // or "fingerprint"\n});',
    );
    expect(replaced).not.toContain("notes()");
  });

  it("adds the scaffold's settings to an adapter call on lines of their own", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    await fs.writeFile(
      configPath,
      `import { bare } from "@hot-updater/bare";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { defineConfig } from "hot-updater";

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: supabaseStorage({
    supabaseUrl: process.env.CUSTOM_SUPABASE_URL!,
  }),
  database: supabaseDatabase({}),
});
`,
      "utf-8",
    );

    await writeHotUpdaterConfig(createSupabaseScaffold("bare"), configPath);

    await expect(fs.readFile(configPath, "utf-8")).resolves
      .toBe(`import { bare } from "@hot-updater/bare";
import { plugins, supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { defineConfig } from "hot-updater";

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: supabaseStorage({
    supabaseUrl: process.env.CUSTOM_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
  }),
  plugins,
});
`);
  });

  it("updates the build adapter only when the selected build changes", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
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
    expect(updatedConfig).toContain(
      'import { rock } from "@hot-updater/rock";',
    );
    expect(updatedConfig).not.toContain(
      'import { bare } from "@hot-updater/bare";',
    );
    expect(updatedConfig).toContain("build: rock()");
    expect(updatedConfig).toContain("debug: true");
  });

  it("keeps a build that wraps a build adapter, with its imports", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    await fs.writeFile(
      configPath,
      `import { bare } from "@hot-updater/bare";
import { withSentry } from "@hot-updater/sentry-plugin";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { defineConfig } from "hot-updater";

export default defineConfig({
  build: withSentry(bare({ enableHermes: true }), {
    org: "acme",
    project: "app",
  }),
  storage: supabaseStorage({}),
  database: supabaseDatabase({}),
  updateStrategy: "appVersion",
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
      "build: withSentry(bare({ enableHermes: true }), {",
    );
    expect(updatedConfig).toContain(
      'import { withSentry } from "@hot-updater/sentry-plugin";',
    );
    expect(updatedConfig).toContain(
      'import { bare } from "@hot-updater/bare";',
    );
    expect(updatedConfig).not.toContain("@hot-updater/rock");
    expect(updatedConfig).toContain("supabaseStorage({");
    expect(updatedConfig).toContain("  plugins,\n");
  });

  it("merges AWS helper and database fields for same-provider re-init", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    await fs.writeFile(
      configPath,
      `import { dynamoDB, s3Storage } from "@hot-updater/aws";
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
  database: dynamoDB({
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
    expect(updatedConfig).toContain(
      'import { dynamoDB, plugins, s3Storage } from "@hot-updater/aws";',
    );
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

describe("writeHotUpdaterConfig imports", () => {
  it("keeps a managed package's import that the project's own kept helper uses", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    await fs.writeFile(configPath, FIREBASE_CERT_CONFIG);

    const result = await writeHotUpdaterConfig(
      createFirebaseScaffold("bare"),
      configPath,
    );
    const updatedConfig = await fs.readFile(configPath, "utf-8");

    expect(result.status).toBe("merged");
    expect(updatedConfig).toContain(
      "const credential = cert(process.env.SERVICE_ACCOUNT_PATH!);",
    );
    expect(updatedConfig).toContain(
      'import { applicationDefault, cert } from "firebase-admin/app";',
    );
    expect(updatedConfig).not.toContain(
      "const credential = applicationDefault();",
    );
  });

  it("keeps the config and says what to change when the project's own import takes a name init imports", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    const existing = FIREBASE_CERT_CONFIG.replace(
      'import { firebaseDatabase, firebaseStorage, plugins } from "@hot-updater/firebase";',
      'import { firebaseDatabase, firebaseStorage } from "@hot-updater/firebase";\nimport { plugins } from "./serverPlugins";',
    );
    await fs.writeFile(configPath, existing);
    vi.spyOn(p.log, "warn").mockImplementation(() => {});

    const result = await writeHotUpdaterConfig(
      createFirebaseScaffold("bare"),
      configPath,
    );

    expect(result.status).not.toBe("merged");
    expect(await fs.readFile(configPath, "utf-8")).toBe(existing);
  });

  it("drops a managed package's import once the rebuilt config no longer uses it", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    await fs.writeFile(configPath, FIREBASE_CERT_CONFIG);

    const result = await writeHotUpdaterConfig(
      createSupabaseScaffold("bare"),
      configPath,
    );
    const updatedConfig = await fs.readFile(configPath, "utf-8");

    expect(result.status).toBe("merged");
    expect(updatedConfig).not.toContain("firebase-admin/app");
    expect(updatedConfig).not.toContain("const credential");
    expect(updatedConfig).toContain(
      'import { plugins, supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";',
    );
  });
});

describe("writeHotUpdaterFiles", () => {
  it("writes the config and says so", async () => {
    const cwd = await createTempDir();
    const success = vi
      .spyOn(p.log, "success")
      .mockImplementation(() => undefined);
    const scaffold = createSupabaseScaffold("bare");

    await expect(
      writeHotUpdaterFiles(scaffold, { cwd, settings: "Supabase" }),
    ).resolves.toEqual({
      config: {
        status: "created",
        path: path.join(cwd, "hot-updater.config.ts"),
      },
    });
    await expect(
      fs.readFile(path.join(cwd, "hot-updater.config.ts"), "utf-8"),
    ).resolves.toBe(`${scaffold.text}\n`);
    expect(success).toHaveBeenCalledWith(
      "Generated 'hot-updater.config.ts' file with Supabase settings.",
    );
  });

  it("keeps a config it cannot merge, and says what to set in it", async () => {
    const cwd = await createTempDir();
    const warn = vi.spyOn(p.log, "warn").mockImplementation(() => undefined);
    const original = `import { defineConfig } from "hot-updater";

export default defineConfig(getConfig());
`;
    await fs.writeFile(
      path.join(cwd, "hot-updater.config.ts"),
      original,
      "utf-8",
    );

    await expect(
      writeHotUpdaterFiles(createAwsScaffold("bare", { profile: "dev" }), {
        cwd,
        settings: "AWS",
      }),
    ).resolves.toMatchObject({ config: { status: "skipped" } });
    await expect(
      fs.readFile(path.join(cwd, "hot-updater.config.ts"), "utf-8"),
    ).resolves.toBe(original);
    expect(warn)
      .toHaveBeenCalledWith(`Kept existing 'hot-updater.config.ts' unchanged: Existing config is not a supported \`export default defineConfig({ ... })\` shape.
Set storage, database, and plugins in its config, as init writes them for AWS:

import { dynamoDB, plugins, s3Storage } from "@hot-updater/aws";
import { fromSSO } from "@aws-sdk/credential-provider-sso";

const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};

  storage: s3Storage(commonOptions),
  database: dynamoDB({
    ...commonOptions,
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  }),
  plugins,`);
  });

  it("removes the plugins file an older init wrote, and names one the project wrote", async () => {
    const cwd = await createTempDir();
    const warn = vi.spyOn(p.log, "warn").mockImplementation(() => undefined);
    vi.spyOn(p.log, "success").mockImplementation(() => undefined);
    const scaffold = createSupabaseScaffold("bare");
    const pluginsPath = path.join(cwd, "hotUpdater.plugins.ts");
    await fs.writeFile(
      pluginsPath,
      [
        "// Generated by `hot-updater init`. The managed server runs these plugins,",
        "// and @hot-updater/supabase fixes the list, so the server, CLI, and console agree.",
        "export { plugins } from '@hot-updater/supabase'",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(
      writeHotUpdaterFiles(scaffold, { cwd, settings: "Supabase" }),
    ).resolves.toMatchObject({ pluginsFile: "removed" });
    await expect(fs.access(pluginsPath)).rejects.toThrow();

    const own = `import { insights } from "@hot-updater/server/plugins/insights";

export const plugins = [insights()];
`;
    await fs.writeFile(pluginsPath, own, "utf-8");

    await expect(
      writeHotUpdaterFiles(scaffold, { cwd, settings: "Supabase" }),
    ).resolves.toMatchObject({ pluginsFile: "kept" });
    await expect(fs.readFile(pluginsPath, "utf-8")).resolves.toBe(own);
    expect(warn).toHaveBeenCalledWith(
      `Nothing reads '${pluginsPath}' anymore: \`plugins\` in 'hot-updater.config.ts' lists the plugins the server runs. Delete it.`,
    );
  });
});
