import { existsSync, statSync } from "fs";
import path from "path";

import { p } from "@hot-updater/cli-tools";
import type { Migrator } from "@hot-updater/server";
import { createJiti } from "jiti";

import { ui } from "../../utils/cli-ui";

export interface HotUpdaterInstance {
  createMigrator?: () => Migrator;
  generateSchema?: (
    version: string | "latest",
    name?: string,
  ) => { code: string; path: string };
  adapterName: string;
}

export interface LoadHotUpdaterResult {
  hotUpdater: HotUpdaterInstance;
  adapterName: string;
  absoluteConfigPath: string;
}

const SUPPORTED_CONFIG_EXTENSIONS = [
  "ts",
  "cts",
  "mts",
  "js",
  "cjs",
  "mjs",
] as const;

const DEFAULT_CONFIG_BASENAMES = [
  "hot-updater.config",
  path.join("src", "hotUpdater"),
  path.join("src", "db"),
] as const;

const findDefaultConfigPath = () => {
  for (const basename of DEFAULT_CONFIG_BASENAMES) {
    for (const ext of SUPPORTED_CONFIG_EXTENSIONS) {
      const candidate = path.resolve(process.cwd(), `${basename}.${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
};

const resolveConfigPath = (configPath: string) => {
  const trimmedConfigPath = configPath.trim();
  if (trimmedConfigPath) {
    return path.resolve(process.cwd(), trimmedConfigPath);
  }

  const defaultConfigPath = findDefaultConfigPath();
  if (defaultConfigPath) {
    return defaultConfigPath;
  }

  p.log.error("Could not find a Hot Updater config file.");
  p.log.message(
    ui.block("Examples", [
      ui.kv("Generate", ui.command("hot-updater db generate src/db.ts")),
      ui.kv("Migrate", ui.command("hot-updater db migrate src/db.ts")),
      ui.kv("SQL", ui.command("hot-updater db generate --sql")),
    ]),
  );
  process.exit(1);
};

/**
 * Load and validate hotUpdater instance from config file
 */
export async function loadHotUpdater(
  configPath: string,
): Promise<LoadHotUpdaterResult> {
  const absoluteConfigPath = resolveConfigPath(configPath);

  // Verify config file exists
  if (!existsSync(absoluteConfigPath)) {
    p.log.error(
      ui.line(["Config file not found:", ui.path(absoluteConfigPath)]),
    );
    process.exit(1);
  }

  if (statSync(absoluteConfigPath).isDirectory()) {
    p.log.error(
      ui.line(["Config path must be a file:", ui.path(absoluteConfigPath)]),
    );
    process.exit(1);
  }

  // Load config file using jiti
  const jiti = createJiti(import.meta.url, { interopDefault: true });

  let moduleExports: Record<string, unknown>;
  try {
    moduleExports = (await jiti.import(absoluteConfigPath)) as Record<
      string,
      unknown
    >;
  } catch (importError) {
    const errorMessage =
      importError instanceof Error ? importError.message : String(importError);

    if (errorMessage.includes("is not a function")) {
      p.log.error("Config import failed.");
    } else if (
      errorMessage.includes("Cannot find module") ||
      errorMessage.includes("Cannot find package")
    ) {
      p.log.error("Failed to load required dependencies.");
    } else {
      p.log.error(
        ui.line(["Failed to load configuration file:", errorMessage]),
      );
    }

    if (process.env["DEBUG"]) {
      console.error("\nDetailed error:");
      console.error(importError);
    } else {
      p.log.info("Run with DEBUG=1 for more details");
    }

    process.exit(1);
  }

  // Extract hotUpdater instance
  const hotUpdater = (moduleExports["hotUpdater"] ||
    moduleExports["default"]) as HotUpdaterInstance | undefined;

  if (!hotUpdater) {
    p.log.error('Could not find "hotUpdater" export in the config file.');
    p.log.message(
      ui.block("Export", [
        ui.kv(
          "Code",
          ui.code("export const hotUpdater = createHotUpdater({ ... })"),
        ),
      ]),
    );
    process.exit(1);
  }

  // Verify hotUpdater is a valid object
  if (typeof hotUpdater !== "object" || !("adapterName" in hotUpdater)) {
    p.log.error(
      "The hotUpdater instance is not valid. " +
        "Please ensure you're using @hot-updater/server's createHotUpdater().",
    );
    process.exit(1);
  }

  const adapterName = hotUpdater.adapterName;
  if (typeof adapterName !== "string") {
    p.log.error(
      "The hotUpdater instance does not have a valid adapterName property.",
    );
    process.exit(1);
  }

  return {
    hotUpdater,
    adapterName,
    absoluteConfigPath,
  };
}
