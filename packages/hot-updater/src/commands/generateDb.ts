import * as p from "@clack/prompts";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { createJiti } from "jiti";
import path from "path";
import { format } from "sql-formatter";

export interface GenerateDbOptions {
  configPath: string;
  outputDir?: string;
}

export async function generateDb(options: GenerateDbOptions) {
  const { configPath, outputDir = "hot-updater_migrations" } = options;

  // Resolve absolute paths
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  const absoluteOutputDir = path.resolve(process.cwd(), outputDir);

  // Verify config file exists
  if (!existsSync(absoluteConfigPath)) {
    p.log.error(`Config file not found: ${absoluteConfigPath}`);
    process.exit(1);
  }

  p.intro("Generating database migrations");

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

    // Generate migration
    p.log.step("Generating SQL migration");
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });

    // Get SQL
    if (!result.getSQL) {
      p.log.error(
        "Migration result does not support SQL generation. " +
          "This may happen if you're not using an SQL-based database adapter.",
      );
      process.exit(1);
    }

    const sql = result.getSQL();

    if (!sql || sql.trim() === "") {
      p.log.warn("No migrations generated - schema is already up to date");
      p.outro("Done");
      return;
    }

    // Format SQL for better readability
    p.log.step("Formatting SQL");
    const formattedSql = format(sql, {
      language: "postgresql",
      tabWidth: 2,
      keywordCase: "upper",
    });

    // Create output directory
    p.log.step(`Creating output directory: ${outputDir}`);
    await mkdir(absoluteOutputDir, { recursive: true });

    // Check for duplicate SQL files using MD5 hash
    p.log.step("Checking for existing migrations");
    const newSqlHash = createHash("md5").update(formattedSql).digest("hex");

    try {
      const files = await readdir(absoluteOutputDir);
      const sqlFiles = files.filter((file) => file.endsWith(".sql"));

      for (const file of sqlFiles) {
        const filePath = path.join(absoluteOutputDir, file);
        const existingContent = await readFile(filePath, "utf-8");
        const existingHash = createHash("md5")
          .update(existingContent)
          .digest("hex");

        if (existingHash === newSqlHash) {
          p.log.warn(
            `Identical migration already exists: ${file}\nNo new migration file created.`,
          );
          p.outro("Done");
          return;
        }
      }
    } catch {
      // Directory doesn't exist yet or can't be read, continue with file creation
    }

    // Generate filename with timestamp (YYYY-MM-DDTHH-MM-SS format)
    const timestamp = new Date()
      .toISOString()
      .split(".")[0]
      ?.replace(/:/g, "-");
    const filename = `migration_${timestamp}.sql`;
    const outputPath = path.join(absoluteOutputDir, filename);

    // Write SQL file
    p.log.step(`Writing SQL to ${filename}`);
    await writeFile(outputPath, formattedSql, "utf-8");

    p.outro(`Migration file generated successfully: ${outputPath}`);
  } catch (error) {
    p.log.error("Failed to generate migrations");
    if (error instanceof Error) {
      p.log.error(error.message);
      if (process.env["DEBUG"]) {
        console.error(error.stack);
      }
    }
    process.exit(1);
  }
}
