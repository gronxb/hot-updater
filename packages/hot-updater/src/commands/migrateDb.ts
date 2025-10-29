import * as p from "@clack/prompts";
import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { createJiti } from "jiti";
import path from "path";

export interface MigrateDbOptions {
  configPath: string;
  targetDir?: string;
  skipConfirm?: boolean;
}

export async function migrateDb(options: MigrateDbOptions) {
  const {
    configPath,
    targetDir = "hot-updater_migrations",
    skipConfirm = false,
  } = options;

  // Resolve absolute paths
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  const absoluteTargetDir = path.resolve(process.cwd(), targetDir);

  // Verify config file exists
  if (!existsSync(absoluteConfigPath)) {
    p.log.error(`Config file not found: ${absoluteConfigPath}`);
    process.exit(1);
  }

  // Verify target directory exists
  if (!existsSync(absoluteTargetDir)) {
    p.log.error(`Target directory not found: ${absoluteTargetDir}`);
    process.exit(1);
  }

  p.intro("Running database migration");

  try {
    // Load config file using jiti
    p.log.step(`Loading configuration from ${configPath}`);
    const jiti = createJiti(import.meta.url, { interopDefault: true });

    let moduleExports: Record<string, unknown>;
    try {
      moduleExports = (await jiti.import(absoluteConfigPath)) as Record<
        string,
        unknown
      >;
    } catch (importError) {
      const errorMessage =
        importError instanceof Error
          ? importError.message
          : String(importError);

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
    const hotUpdater = moduleExports["hotUpdater"] || moduleExports["default"];

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

    // Verify hotUpdater has createMigrator method
    if (
      typeof hotUpdater !== "object" ||
      !("createMigrator" in hotUpdater) ||
      typeof hotUpdater.createMigrator !== "function"
    ) {
      p.log.error(
        "The hotUpdater instance does not have a createMigrator() method. " +
          "Please ensure you're using @hot-updater/server's createHotUpdater().",
      );
      process.exit(1);
    }

    // Read SQL files from target directory
    p.log.step(`Reading SQL files from ${targetDir}`);
    const files = await readdir(absoluteTargetDir);
    const sqlFiles = files.filter((file) => file.endsWith(".sql")).sort();

    if (sqlFiles.length === 0) {
      p.log.warn(`No SQL files found in ${targetDir}`);
      p.outro("Done");
      return;
    }

    p.log.info(`Found ${sqlFiles.length} SQL file(s)`);

    // Confirm before executing migrations
    if (!skipConfirm) {
      const shouldContinue = await p.confirm({
        message: `Execute ${sqlFiles.length} migration file(s)?`,
        initialValue: true,
      });

      if (p.isCancel(shouldContinue) || !shouldContinue) {
        p.cancel("Operation cancelled");
        process.exit(0);
      }
    }

    // Create migrator
    p.log.step("Creating migrator");
    const migrator = hotUpdater.createMigrator();

    // Execute each SQL file
    for (const sqlFile of sqlFiles) {
      const filePath = path.join(absoluteTargetDir, sqlFile);
      p.log.step(`Executing ${sqlFile}`);

      const sql = await readFile(filePath, "utf-8");

      // Run migration from SQL
      const result = await migrator.migrateToLatest({
        mode: "from-sql",
        sql,
        updateSettings: true,
      });

      await result.execute();
      p.log.success(`Completed ${sqlFile}`);
    }

    p.outro("Database migration completed successfully");
  } catch (error) {
    p.log.error("Failed to run migration");
    if (error instanceof Error) {
      p.log.error(error.message);
      if (process.env["DEBUG"]) {
        console.error(error.stack);
      }
    }
    process.exit(1);
  }
}
