import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { afterEach, describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import {
  createHotUpdaterConfigScaffold,
  writeHotUpdaterConfig,
} from "./hotUpdaterConfig";

const tempDirectories: string[] = [];

const createSupabaseScaffold = () =>
  createHotUpdaterConfigScaffold({
    build: "bare",
    storage: {
      imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseStorage"] }],
      configString: `supabaseStorage({
  supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
  supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
})`,
    },
    database: {
      imports: [{ pkg: "@hot-updater/supabase", named: ["supabaseDatabase"] }],
      configString: `supabaseDatabase({
  supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
  supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
})`,
    },
  });

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("OXC hot updater config migration", () => {
  it("keeps config migration independent from the TypeScript compiler API", async () => {
    // Given a published CLI package that edits TypeScript config files
    const { dependencies } = packageJson;
    const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
    const configSourceFiles = (await fs.readdir(sourceDirectory)).filter(
      (fileName) =>
        fileName.startsWith("hotUpdaterConfig") &&
        fileName.endsWith(".ts") &&
        !fileName.endsWith(".spec.ts"),
    );

    // When its runtime dependencies and config editor imports are inspected
    const dependencyNames = Object.keys(dependencies);
    const configSources = await Promise.all(
      configSourceFiles.map((fileName) =>
        fs.readFile(path.join(sourceDirectory, fileName), "utf-8"),
      ),
    );

    // Then OXC owns parsing without shipping a TypeScript compiler
    expect(dependencyNames).toContain("oxc-parser");
    expect(dependencyNames).not.toContain("@typescript/native");
    expect(dependencyNames).not.toContain("typescript");
    expect(configSources.join("\n")).not.toContain('from "typescript"');
  });

  it("preserves comments and unmanaged TypeScript statements", async () => {
    // Given a config with user-owned imports, comments, and TypeScript syntax
    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-config-oxc-"),
    );
    tempDirectories.push(tempDirectory);
    const configPath = path.join(tempDirectory, "hot-updater.config.ts");
    await fs.writeFile(
      configPath,
      `// project config
import { customTool } from "./custom";
import { bare } from "@hot-updater/bare";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater" });

// user-owned options
const customOptions = { enabled: true } satisfies Record<string, boolean>;

// user-owned export note
export default defineConfig({
  custom: customTool(customOptions),
  build: bare(),
  storage: supabaseStorage({
    supabaseUrl: process.env.CUSTOM_SUPABASE_URL!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.CUSTOM_SUPABASE_URL!,
  }),
});
`,
      "utf-8",
    );

    // When provider-managed fields are merged
    const result = await writeHotUpdaterConfig(
      createSupabaseScaffold(),
      configPath,
    );
    const updatedConfig = await fs.readFile(configPath, "utf-8");

    // Then user-owned syntax and its leading comments remain intact
    expect(result.status).toBe("merged");
    expect(updatedConfig).toContain("// project config");
    expect(updatedConfig).toContain('import { customTool } from "./custom";');
    expect(updatedConfig).toContain("// user-owned options");
    expect(updatedConfig).toContain("satisfies Record<string, boolean>");
    expect(updatedConfig).toContain("// user-owned export note");
    expect(updatedConfig).toContain("custom: customTool(customOptions)");
  });
});
