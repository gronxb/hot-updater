import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type BuildType,
  ConfigBuilder,
  type ProviderConfig,
} from "./ConfigBuilder";
import {
  createHotUpdaterConfigScaffoldFromBuilder,
  type ManagedHelperStatement,
  writeHotUpdaterConfig,
  writeHotUpdaterFiles,
} from "./hotUpdaterConfig";
import { p } from "./prompts";

const tempDirs: string[] = [];

const createTempDir = async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-config-"),
  );
  tempDirs.push(tempDir);
  return tempDir;
};

const createSupabaseScaffold = (build: BuildType) => {
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
      .setBuildType(build)
      .setStorage(storage)
      .setDatabase(database)
      .setPlugins({
        imports: [
          {
            pkg: "hot-updater/plugins",
            named: ["apiKeys", "insights", "remoteConfig"],
          },
        ],
        configString: "[apiKeys(), insights(), remoteConfig()]",
      }),
  );
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
    .setBuildType(build)
    .setStorage(storage)
    .setDatabase(database)
    .setPlugins({
      imports: [
        {
          pkg: "hot-updater/plugins",
          named: ["apiKeys", "insights", "remoteConfig"],
        },
      ],
      configString: "[apiKeys(), insights(), remoteConfig()]",
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

const createFirebaseScaffold = (build: BuildType) => {
  const helperStatements: ManagedHelperStatement[] = [
    {
      name: "credential",
      strategy: "preserve-existing",
      code: "const credential = applicationDefault();",
    },
  ];
  const builder = new ConfigBuilder()
    .setBuildType(build)
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
      imports: [
        {
          pkg: "hot-updater/plugins",
          named: ["apiKeys", "insights", "remoteConfig"],
        },
      ],
      configString: "[apiKeys(), insights(), remoteConfig()]",
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
  it.each([
    ["Supabase", () => createSupabaseScaffold("bare")],
    ["AWS", () => createAwsScaffold("bare", { profile: null })],
    ["Firebase", () => createFirebaseScaffold("bare")],
  ] as const)(
    "keeps one plugin factory import across repeated %s init",
    async (_, createScaffold) => {
      const configPath = path.join(
        await createTempDir(),
        "hot-updater.config.ts",
      );
      const scaffold = createScaffold();
      await writeHotUpdaterConfig(scaffold, configPath);
      await writeHotUpdaterConfig(scaffold, configPath);
      const updated = await fs.readFile(configPath, "utf-8");

      expect(updated.match(/from "hot-updater\/plugins"/gu)).toHaveLength(1);
      expect(updated).toContain(
        'import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";',
      );
      expect(updated).toContain(
        "plugins: [apiKeys(), insights(), remoteConfig()]",
      );

      await writeHotUpdaterConfig(scaffold, configPath);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(updated);
    },
  );

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
      'import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";',
    );
    expect(updatedConfig).toContain(
      "  plugins: [apiKeys(), insights(), remoteConfig()],\n}",
    );
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
    // A config written before init added the server plugin list.
    await fs.writeFile(
      configPath,
      `${scaffold.text.replace("  plugins: [apiKeys(), insights(), remoteConfig()],\n", "")}\n`,
      "utf-8",
    );

    await writeHotUpdaterConfig(scaffold, configPath);
    const added = await fs.readFile(configPath, "utf-8");
    expect(added).toContain(
      '  updateStrategy: "appVersion", // or "fingerprint"\n  plugins: [apiKeys(), insights(), remoteConfig()],\n});',
    );
    expect(added).toContain(
      'import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";',
    );
    await writeHotUpdaterConfig(scaffold, configPath);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(added);

    await fs.writeFile(
      configPath,
      `${scaffold.text.replace("  plugins: [apiKeys(), insights(), remoteConfig()],\n", "  plugins: [apiKeys(), insights({}), remoteConfig(), notes()],\n")}\n`,
      "utf-8",
    );
    await writeHotUpdaterConfig(scaffold, configPath);
    const replaced = await fs.readFile(configPath, "utf-8");
    expect(replaced).toContain(
      '  }),\n  plugins: [apiKeys(), insights(), remoteConfig()],\n  updateStrategy: "appVersion", // or "fingerprint"\n});',
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
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { defineConfig } from "hot-updater";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";

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
  plugins: [apiKeys(), insights(), remoteConfig()],
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
    expect(updatedConfig).toContain(
      "  plugins: [apiKeys(), insights(), remoteConfig()],\n",
    );
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
      'import { dynamoDB, s3Storage } from "@hot-updater/aws";',
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
  it.each([
    "const insights = {};",
    "function insights() {}",
    "class insights {}",
    "const { insights } = { insights: {} };",
  ])(
    "keeps the original when a factory import conflicts with %s",
    async (declaration) => {
      const configPath = path.join(
        await createTempDir(),
        "hot-updater.config.ts",
      );
      const existing = `import { defineConfig } from "hot-updater";
${declaration}
export default defineConfig({});
`;
      await fs.writeFile(configPath, existing);

      const result = await writeHotUpdaterConfig(
        createSupabaseScaffold("bare"),
        configPath,
      );

      expect(result.status).toBe("skipped");
      expect(result.reason).toContain("The declaration of insights conflicts");
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(existing);
    },
  );

  it.each([
    'import { cert as insights } from "firebase-admin/app";',
    'import { remoteConfig as insights } from "hot-updater/plugins";',
  ])(
    "keeps an alias used by preserved code from being rebound: %s",
    async (importLine) => {
      const configPath = path.join(
        await createTempDir(),
        "hot-updater.config.ts",
      );
      const existing = `${importLine}
import { defineConfig } from "hot-updater";
const existingValue = insights();
export default defineConfig({});
`;
      await fs.writeFile(configPath, existing);

      const result = await writeHotUpdaterConfig(
        createSupabaseScaffold("bare"),
        configPath,
      );

      expect(result.status).toBe("skipped");
      expect(result.reason).toContain("The import of insights");
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(existing);
    },
  );

  it("drops a managed alias whose only use was in the replaced plugin list", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    await fs.writeFile(
      configPath,
      `import { remoteConfig as insights } from "hot-updater/plugins";
import { defineConfig } from "hot-updater";
export default defineConfig({ plugins: [insights()] });
`,
    );

    const result = await writeHotUpdaterConfig(
      createSupabaseScaffold("bare"),
      configPath,
    );
    const updated = await fs.readFile(configPath, "utf-8");

    expect(result.status).toBe("merged");
    expect(updated).not.toContain("remoteConfig as insights");
    expect(updated).toContain(
      'import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";',
    );
  });

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
      'import { firebaseDatabase, firebaseStorage } from "@hot-updater/firebase";\nimport { insights } from "./serverPlugins";',
    ).replace("  plugins,", "  plugins: [insights()],");
    await fs.writeFile(configPath, existing);
    vi.spyOn(p.log, "warn").mockImplementation(() => {});

    const result = await writeHotUpdaterConfig(
      createFirebaseScaffold("bare"),
      configPath,
    );

    expect(result.status).not.toBe("merged");
    expect(await fs.readFile(configPath, "utf-8")).toBe(existing);
  });

  it("migrates provider plugin shorthand without keeping imports used only as property names or text", async () => {
    const configPath = path.join(
      await createTempDir(),
      "hot-updater.config.ts",
    );
    await fs.writeFile(
      configPath,
      FIREBASE_CERT_CONFIG.replace(
        "export default defineConfig({",
        `// plugins remain a config property.
const metadata = { plugins: "plugins" };
const label = metadata.plugins;

export default defineConfig({`,
      ),
    );

    const result = await writeHotUpdaterConfig(
      createFirebaseScaffold("bare"),
      configPath,
    );
    const updated = await fs.readFile(configPath, "utf-8");

    expect(result.status).toBe("merged");
    expect(updated).toContain(
      'import { firebaseDatabase, firebaseStorage } from "@hot-updater/firebase";',
    );
    expect(updated).toContain('const metadata = { plugins: "plugins" };');
    expect(updated).toContain("const label = metadata.plugins;");
    expect(updated).toContain(
      "plugins: [apiKeys(), insights(), remoteConfig()]",
    );
  });

  it.each(["[...plugins]", "{ plugins }", "{ [plugins.length]: true }"])(
    "keeps a provider plugin import still referenced by %s outside managed settings",
    async (expression) => {
      const configPath = path.join(
        await createTempDir(),
        "hot-updater.config.ts",
      );
      await fs.writeFile(
        configPath,
        FIREBASE_CERT_CONFIG.replace(
          "export default defineConfig({",
          `const projectPlugins = ${expression};\n\nexport default defineConfig({`,
        ),
      );

      const result = await writeHotUpdaterConfig(
        createFirebaseScaffold("bare"),
        configPath,
      );
      const updated = await fs.readFile(configPath, "utf-8");

      expect(result.status).toBe("merged");
      expect(updated).toContain(
        'import { firebaseDatabase, firebaseStorage, plugins } from "@hot-updater/firebase";',
      );
      expect(updated).toContain(`const projectPlugins = ${expression};`);
      expect(updated).toContain(
        "plugins: [apiKeys(), insights(), remoteConfig()]",
      );
    },
  );

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
      'import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";',
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

import { dynamoDB, s3Storage } from "@hot-updater/aws";
import { fromSSO } from "@aws-sdk/credential-provider-sso";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";

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
  plugins: [apiKeys(), insights(), remoteConfig()],`);
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
