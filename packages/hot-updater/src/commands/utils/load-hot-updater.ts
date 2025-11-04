import * as p from "@clack/prompts";
import type { Migrator } from "@hot-updater/server";
import { existsSync } from "fs";
import { createJiti } from "jiti";
import path from "path";

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

/**
 * Load and validate hotUpdater instance from config file
 */
export async function loadHotUpdater(
  configPath: string,
): Promise<LoadHotUpdaterResult> {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);

  // Verify config file exists
  if (!existsSync(absoluteConfigPath)) {
    p.log.error(`Config file not found: ${absoluteConfigPath}`);
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
      p.log.error(
        "Failed to load the config file due to an import error.\n" +
          "This usually happens when:\n" +
          "  1. '@hot-updater/server' package is not installed\n" +
          "  2. The import statement is incorrect\n\n" +
          "Solutions:\n" +
          "  • Run: pnpm install @hot-updater/server\n" +
          "  • Verify your import: import { createHotUpdater } from '@hot-updater/server'\n" +
          "  • Ensure you're exporting: export const hotUpdater = createHotUpdater({...})",
      );
    } else if (
      errorMessage.includes("Cannot find module") ||
      errorMessage.includes("Cannot find package")
    ) {
      p.log.error(
        "Failed to load required dependencies.\n\n" +
          "Please run: pnpm install\n\n" +
          "If the error persists, check that all packages in your config file are installed.",
      );
    } else {
      p.log.error(
        `Failed to load configuration file: ${errorMessage}\n\n` +
          "Please check:\n" +
          "  • The config file syntax is valid TypeScript/JavaScript\n" +
          "  • All imported packages are installed\n" +
          "  • The file path is correct",
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
    p.log.error(
      'Could not find "hotUpdater" export in the config file.\n\n' +
        "Your config file should export a hotUpdater instance:\n\n" +
        "  import { createHotUpdater } from '@hot-updater/server';\n" +
        "  import { kyselyAdapter } from '@hot-updater/server/adapters/kysely';\n\n" +
        "  export const hotUpdater = createHotUpdater({\n" +
        "    database: kyselyAdapter({ db: kysely, provider: 'postgresql' }),\n" +
        "    storagePlugins: [...],\n" +
        "  });",
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
