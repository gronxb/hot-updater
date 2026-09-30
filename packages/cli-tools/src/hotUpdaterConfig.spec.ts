import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type BuildType, ConfigBuilder } from "./ConfigBuilder";
import {
  createHotUpdaterConfigScaffoldFromBuilder,
  loadManagedServerDefinition,
  readManagedServerDefinition,
  readServerDefinitionStatus,
  replacingServerDefinitions,
  writeHotUpdaterConfig,
  writeHotUpdaterFiles,
  writeServerDefinition,
} from "./hotUpdaterConfig";
import { InitError } from "./initOptions";
import { p } from "./prompts";

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

/** The definition another managed provider's init writes. */
const createCloudflareScaffold = (build: BuildType) =>
  createHotUpdaterConfigScaffoldFromBuilder(
    new ConfigBuilder()
      .setBuildType(build)
      .setStorage({
        imports: [{ pkg: "@hot-updater/cloudflare", named: ["r2Storage"] }],
        configString: `r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
  })`,
      })
      .setDatabase({
        imports: [{ pkg: "@hot-updater/cloudflare", named: ["d1Database"] }],
        configString: `d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
  })`,
      })
      .setPlugins({
        imports: [{ pkg: "@hot-updater/cloudflare", named: ["plugins"] }],
        configString: "plugins",
      }),
  );

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("readServerDefinitionStatus", () => {
  it("reads a definition a formatter rewrote as the one init wrote", async () => {
    const definitionPath = path.join(await createTempDir(), "hotUpdater.ts");
    const scaffold = createSupabaseScaffold("bare");
    // Another formatter's style: sorted, wrapped imports, single quotes, no
    // semicolons, and a wrapped property.
    const formatted = scaffold.definition.text
      .replace(
        'import { plugins, supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";\nimport { createHotUpdater } from "@hot-updater/server";',
        "import { createHotUpdater } from '@hot-updater/server'\nimport {\n  supabaseStorage,\n  plugins,\n  supabaseDatabase,\n} from '@hot-updater/supabase'",
      )
      .replace(
        "    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,",
        "    bucketName:\n      process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,",
      )
      .replace("});", "})");
    expect(formatted).not.toBe(scaffold.definition.text);
    await fs.writeFile(definitionPath, formatted, "utf-8");

    await expect(
      readServerDefinitionStatus(scaffold, definitionPath),
    ).resolves.toBe("unchanged");

    await fs.writeFile(
      definitionPath,
      formatted.replace("  plugins,\n", "  plugins: [...plugins, notes()],\n"),
      "utf-8",
    );
    await expect(
      readServerDefinitionStatus(scaffold, definitionPath),
    ).resolves.toBe("edited");
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

describe("writeHotUpdaterFiles", () => {
  it("keeps a wrapped build, points the config at the server, and writes the definition", async () => {
    const cwd = await createTempDir();
    vi.spyOn(p.log, "success").mockImplementation(() => undefined);
    await fs.writeFile(
      path.join(cwd, "hot-updater.config.ts"),
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
    const scaffold = createSupabaseScaffold("bare");

    const result = await writeHotUpdaterFiles(scaffold, {
      cwd,
      settings: "Supabase",
    });

    expect(result).toMatchObject({
      config: { status: "merged", server: "./hotUpdater.ts" },
      definition: { status: "created" },
    });
    const config = await fs.readFile(
      path.join(cwd, "hot-updater.config.ts"),
      "utf-8",
    );
    expect(config).toContain(
      "build: withSentry(bare({ enableHermes: true }), {",
    );
    expect(config).toContain(
      'import { withSentry } from "@hot-updater/sentry-plugin";',
    );
    expect(config).toContain('import { bare } from "@hot-updater/bare";');
    expect(config).toContain('server: "./hotUpdater.ts",');
    expect(config).not.toContain("storage:");
    expect(config).not.toContain("@hot-updater/supabase");
    await expect(
      fs.readFile(path.join(cwd, "hotUpdater.ts"), "utf-8"),
    ).resolves.toBe(`${scaffold.definition.text}\n`);
  });

  it("writes the definition beside a config it cannot merge, and says what to change", async () => {
    const cwd = await createTempDir();
    const warn = vi.spyOn(p.log, "warn").mockImplementation(() => undefined);
    vi.spyOn(p.log, "success").mockImplementation(() => undefined);
    const original = `import { defineConfig } from "hot-updater";

export default defineConfig(getConfig({ storage: s3(), database: d1() }));
`;
    await fs.writeFile(
      path.join(cwd, "hot-updater.config.ts"),
      original,
      "utf-8",
    );
    const scaffold = createSupabaseScaffold("bare");

    const result = await writeHotUpdaterFiles(scaffold, {
      cwd,
      settings: "Supabase",
    });

    expect(result).toMatchObject({
      config: { status: "skipped" },
      definition: { status: "created" },
    });
    await expect(
      fs.readFile(path.join(cwd, "hot-updater.config.ts"), "utf-8"),
    ).resolves.toBe(original);
    await expect(
      fs.readFile(path.join(cwd, "hotUpdater.ts"), "utf-8"),
    ).resolves.toBe(`${scaffold.definition.text}\n`);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Add `server: "./hotUpdater.ts",` to its config, and remove storage, database: the server definition holds them.',
      ),
    );
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
      `Nothing reads '${pluginsPath}' anymore: move its plugins into the plugins of 'hotUpdater.ts', then delete it.`,
    );
  });
});

describe("readManagedServerDefinition", () => {
  it("names the definition a managed init deploys, and whether the project edited it", async () => {
    const cwd = await createTempDir();
    const scaffold = createSupabaseScaffold("bare");
    const definitionPath = path.join(cwd, "hotUpdater.ts");

    // None yet, or the one init writes: the provider's prebuilt server runs.
    await expect(readManagedServerDefinition(scaffold, cwd)).resolves.toEqual({
      path: definitionPath,
      edited: false,
    });
    await fs.writeFile(definitionPath, `${scaffold.definition.text}\n`);
    await expect(readManagedServerDefinition(scaffold, cwd)).resolves.toEqual({
      path: definitionPath,
      edited: false,
    });

    // The project's own plugins: init bundles the definition.
    await fs.writeFile(
      definitionPath,
      scaffold.definition.text.replace(
        "  plugins,\n",
        "  plugins: [...plugins, notes()],\n",
      ),
    );
    await expect(readManagedServerDefinition(scaffold, cwd)).resolves.toEqual({
      path: definitionPath,
      edited: true,
    });

    // The one the config points at.
    await fs.writeFile(
      path.join(cwd, "hot-updater.config.ts"),
      `import { defineConfig } from "hot-updater";

export default defineConfig({
  server: "./servers/supabase.ts",
});
`,
    );
    await expect(readManagedServerDefinition(scaffold, cwd)).resolves.toEqual({
      path: path.join(cwd, "servers/supabase.ts"),
      edited: false,
    });
  });
});

describe("switching managed providers", () => {
  it("replaces the definition another provider's init wrote", async () => {
    const cwd = await createTempDir();
    vi.spyOn(p.log, "success").mockImplementation(() => undefined);
    const definitionPath = path.join(cwd, "hotUpdater.ts");
    const cloudflare = createCloudflareScaffold("bare");
    await fs.writeFile(definitionPath, `${cloudflare.definition.text}\n`);
    const supabase = replacingServerDefinitions(
      createSupabaseScaffold("bare"),
      [cloudflare.definition.text],
    );

    // Not the project's own: the provider's prebuilt server runs.
    await expect(readManagedServerDefinition(supabase, cwd)).resolves.toEqual({
      path: definitionPath,
      edited: false,
    });
    await expect(
      writeHotUpdaterFiles(supabase, { cwd, settings: "Supabase" }),
    ).resolves.toMatchObject({ definition: { status: "updated" } });
    await expect(fs.readFile(definitionPath, "utf-8")).resolves.toBe(
      `${supabase.definition.text}\n`,
    );
  });

  it("refuses a definition the project wrote for another provider before init touches anything", async () => {
    const cwd = await createTempDir();
    const definitionPath = path.join(cwd, "hotUpdater.ts");
    const cloudflare = createCloudflareScaffold("bare");
    await fs.writeFile(
      definitionPath,
      cloudflare.definition.text.replace(
        "  plugins,\n",
        "  plugins: [...plugins, notes()],\n",
      ),
    );

    await expect(
      readManagedServerDefinition(
        replacingServerDefinitions(createSupabaseScaffold("bare"), [
          cloudflare.definition.text,
        ]),
        cwd,
      ),
    ).rejects.toThrow(
      "hotUpdater.ts defines a cloudflare server: it imports @hot-updater/cloudflare. To deploy it, run `hot-updater init --provider cloudflare`. To deploy the managed supabase server, give hotUpdater.ts the database and storage of @hot-updater/supabase, or remove it and rerun init, which writes one.",
    );
  });
});

describe("loadManagedServerDefinition", () => {
  it("loads the definition with the settings init writes, and gives the process its own back", async () => {
    const cwd = await createTempDir();
    const definitionPath = path.join(cwd, "hotUpdater.ts");
    await fs.writeFile(
      path.join(cwd, ".env.hotupdater"),
      "HOT_UPDATER_MANAGED_SPEC_BUCKET=from-file\nHOT_UPDATER_MANAGED_SPEC_PROJECT=from-file\nHOT_UPDATER_MANAGED_SPEC_KEY=placeholder\n",
    );
    await fs.writeFile(
      definitionPath,
      "export const hotUpdater = { bucket: process.env.HOT_UPDATER_MANAGED_SPEC_BUCKET, project: process.env.HOT_UPDATER_MANAGED_SPEC_PROJECT, key: process.env.HOT_UPDATER_MANAGED_SPEC_KEY };\n",
    );
    // A stale value in the shell loses to what init writes.
    process.env["HOT_UPDATER_MANAGED_SPEC_PROJECT"] = "from-shell";

    try {
      await expect(
        loadManagedServerDefinition(
          { path: definitionPath, edited: true },
          (hotUpdater) => hotUpdater,
          {
            cwd,
            env: {
              HOT_UPDATER_MANAGED_SPEC_BUCKET: "about-to-write",
              HOT_UPDATER_MANAGED_SPEC_KEY: undefined,
            },
          },
        ),
      ).resolves.toEqual({
        bucket: "about-to-write",
        project: "from-file",
        key: undefined,
      });
      expect(process.env["HOT_UPDATER_MANAGED_SPEC_PROJECT"]).toBe(
        "from-shell",
      );
      expect(process.env["HOT_UPDATER_MANAGED_SPEC_BUCKET"]).toBeUndefined();
      expect(process.env["HOT_UPDATER_MANAGED_SPEC_KEY"]).toBeUndefined();
    } finally {
      delete process.env["HOT_UPDATER_MANAGED_SPEC_PROJECT"];
    }
  });

  it("names the definition and says what to do when it cannot load or run", async () => {
    const cwd = await createTempDir();
    const definitionPath = path.join(cwd, "hotUpdater.ts");
    await fs.writeFile(
      definitionPath,
      'import { plugins } from "@hot-updater/not-installed";\nexport const hotUpdater = plugins;\n',
    );

    const missing = loadManagedServerDefinition(
      { path: definitionPath, edited: true },
      (hotUpdater) => hotUpdater,
      { cwd },
    );
    await expect(missing).rejects.toBeInstanceOf(InitError);
    await expect(missing).rejects.toThrow(
      /^Could not load hotUpdater\.ts: .*@hot-updater\/not-installed.* Install the packages it imports in this project, then rerun init\.$/su,
    );

    await fs.writeFile(definitionPath, "export const hotUpdater = {};\n");
    const refused = loadManagedServerDefinition(
      { path: path.join(cwd, "server.ts"), edited: true },
      () => {
        throw new Error("The managed Test server runs on testDatabase.");
      },
      { cwd },
    );
    await expect(refused).rejects.toBeInstanceOf(InitError);
  });
});
