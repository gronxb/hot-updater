import { existsSync } from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { createJiti } from "jiti";

export interface MigrateDbOptions {
  configPath: string;
}

export async function migrateDb(options: MigrateDbOptions) {
  const { configPath } = options;

  // Resolve absolute path
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);

  // Verify config file exists
  if (!existsSync(absoluteConfigPath)) {
    p.log.error(`Config file not found: ${absoluteConfigPath}`);
    process.exit(1);
  }

  p.intro("Running database migration");

  try {
    // Load config file using jiti
    p.log.step(`Loading configuration from ${configPath}`);
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const moduleExports = (await jiti.import(absoluteConfigPath)) as Record<
      string,
      unknown
    >;

    // Extract hotUpdater instance
    const hotUpdater = moduleExports["hotUpdater"] || moduleExports["default"];

    if (!hotUpdater) {
      p.log.error(
        'Could not find "hotUpdater" export in the config file. ' +
          "Please ensure your config exports a hotUpdater instance created with createHotUpdater().",
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

    // Create migrator
    p.log.step("Creating migrator");
    const migrator = hotUpdater.createMigrator();

    // Run migration
    p.log.step("Running migration to latest version");
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });

    // Execute migration
    p.log.step("Applying migration to database");
    await result.execute();

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
