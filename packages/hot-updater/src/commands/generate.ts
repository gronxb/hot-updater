import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import path from "path";

import { p } from "@hot-updater/cli-tools";
import {
  createMigrator as createHotUpdaterMigrator,
  generateSchema as generateHotUpdaterSchema,
} from "@hot-updater/server/db";
import {
  formatDialect,
  mysql as mysqlDialect,
  postgresql as postgresqlDialect,
} from "sql-formatter";

import { ui } from "../utils/cli-ui";
import { generatePrismaSchema } from "./generate-prisma-schema";
import { generateStandaloneSQL } from "./generate-standalone-sql";
import {
  GenerateExit,
  requestGenerateExit,
} from "./utils/generate-command-control";
import { resolveGeneratedSchemaOutputPath } from "./utils/generated-schema-artifact";
import {
  type LoadHotUpdaterResult,
  loadHotUpdater,
} from "./utils/load-hot-updater";

export interface GenerateOptions {
  configPath: string;
  outputDir?: string;
  skipConfirm?: boolean;
  sql?: boolean | string;
}

export async function generate(options: GenerateOptions) {
  const {
    configPath,
    outputDir = undefined,
    skipConfirm = false,
    sql = false,
  } = options;

  // If --sql flag is set, use standalone SQL generation
  if (sql) {
    return generateStandaloneSQL({
      outputDir: outputDir || ".",
      skipConfirm,
      provider: typeof sql === "string" ? sql : undefined,
    });
  }

  let loadedConfig: LoadHotUpdaterResult | undefined;
  let exitCode: number | undefined;

  try {
    // Start spinner early to show progress during config loading
    const s = p.spinner();
    s.start("Loading configuration and analyzing schema");

    // Load hotUpdater instance from config file
    loadedConfig = await loadHotUpdater(configPath, {
      allowGeneratedSchemaPlaceholder: true,
    });
    const { hotUpdater, adapterName } = loadedConfig;

    // Set default outputDir based on adapter type
    const defaultOutputDir =
      adapterName === "kysely"
        ? "hot-updater_migrations" // SQL migrations
        : "."; // Schema files

    const finalOutputDir = outputDir || defaultOutputDir;
    const absoluteOutputDir = path.resolve(process.cwd(), finalOutputDir);

    // Execute generation based on adapter type
    switch (adapterName) {
      case "kysely":
        // Use createMigrator to generate SQL migration files
        await generateWithMigrator(
          hotUpdater,
          absoluteOutputDir,
          skipConfirm,
          s,
        );
        break;

      case "drizzle":
      case "prisma":
        // Use generateSchema to generate TypeScript schema files
        await generateWithSchemaGenerator(
          hotUpdater,
          adapterName,
          absoluteOutputDir,
          skipConfirm,
          s,
        );
        break;
      case "mongodb":
        s.stop("Generation not supported");
        p.log.error(
          "MongoDB does not support migration file generation. " +
            "Use `hot-updater db migrate` to create collections and indexes.",
        );
        requestGenerateExit(1);
        break;
      default:
        p.log.error(
          `Unsupported adapter: ${adapterName}. Generation is not supported.`,
        );
        requestGenerateExit(1);
        break;
    }
  } catch (error) {
    if (error instanceof GenerateExit) {
      exitCode = error.code;
    } else if (error instanceof Error) {
      p.log.error("Failed to generate");
      p.log.error(error.message);
      if (process.env["DEBUG"]) {
        console.error(error.stack);
      }
      exitCode = 1;
    } else {
      p.log.error("Failed to generate");
      p.log.error(String(error));
      exitCode = 1;
    }
  } finally {
    await loadedConfig?.dispose();
  }

  if (exitCode !== undefined) {
    process.exit(exitCode);
  }
}

/**
 * Generate SQL migration files using createMigrator (for kysely/mongodb)
 */
async function generateWithMigrator(
  hotUpdater: LoadHotUpdaterResult["hotUpdater"],
  absoluteOutputDir: string,
  skipConfirm: boolean,
  s: ReturnType<typeof p.spinner>,
) {
  // Create migrator
  const migrator = createHotUpdaterMigrator(hotUpdater);

  // Generate migration
  const result = await migrator.migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  });

  s.stop("Analysis complete");

  // Get SQL
  const getSQL = result.getSQL;
  let sql: string;
  if (typeof getSQL === "function") {
    sql = getSQL();
  } else {
    p.log.error(
      "Migration result does not support SQL generation. " +
        "This may happen if you're not using an SQL-based database plugin.",
    );
    requestGenerateExit(1);
    return;
  }

  if (!sql || sql.trim() === "") {
    p.log.success("Schema is up to date.");
    return;
  }

  let formattedSql = sql;
  const formatDialects = [postgresqlDialect, mysqlDialect] as const;

  for (const dialect of formatDialects) {
    try {
      formattedSql = formatDialect(sql, {
        dialect,
        tabWidth: 2,
        keywordCase: "upper",
      });
      break;
    } catch {
      // Continue to next language
    }
  }

  // Create output directory
  await mkdir(absoluteOutputDir, { recursive: true });

  try {
    const files = await readdir(absoluteOutputDir);
    const sqlFiles = files.filter((file) => file.endsWith(".sql"));

    for (const file of sqlFiles) {
      const filePath = path.join(absoluteOutputDir, file);
      const existingContent = await readFile(filePath, "utf-8");

      if (existingContent === formattedSql) {
        p.log.warn(`Identical migration already exists: ${file}`);
        p.outro("Done");
        return;
      }
    }
  } catch {
    // Directory doesn't exist yet or can't be read, continue with file creation
  }

  // Generate filename with timestamp (YYYY-MM-DDTHH-MM-SS format)
  const timestamp = new Date().toISOString().split(".")[0]?.replace(/:/g, "-");
  const filename = `migration_${timestamp}.sql`;
  const outputPath = path.join(absoluteOutputDir, filename);

  // Confirm before writing SQL file
  if (!skipConfirm) {
    const shouldContinue = await p.confirm({
      message: `Generate migration file: ${filename}?`,
      initialValue: true,
    });

    if (p.isCancel(shouldContinue) || !shouldContinue) {
      p.cancel("Operation cancelled");
      requestGenerateExit(0);
    }
  }

  // Write SQL file
  await writeFile(outputPath, formattedSql, "utf-8");

  p.log.success(ui.line(["Created", ui.path(outputPath)]));
}

/**
 * Generate TypeScript schema files using generateSchema (for drizzle/prisma/typeorm)
 */
async function generateWithSchemaGenerator(
  hotUpdater: LoadHotUpdaterResult["hotUpdater"],
  adapterName: string,
  absoluteOutputDir: string,
  skipConfirm: boolean,
  s: ReturnType<typeof p.spinner>,
) {
  // Generate schema
  const schemaResult = generateHotUpdaterSchema(hotUpdater, "latest");

  s.stop("Analysis complete");

  const schemaCode = schemaResult.code;
  if (!schemaCode || schemaCode.trim() === "") {
    p.log.info("No schema generated.");
    return;
  }

  // Special handling for Prisma adapter - write directly to schema.prisma
  if (adapterName === "prisma") {
    await generatePrismaSchema(schemaCode, absoluteOutputDir, skipConfirm);
    return;
  }

  const outputPath = resolveGeneratedSchemaOutputPath(
    schemaResult,
    absoluteOutputDir,
  );
  const outputDirectory = path.dirname(outputPath);
  const filename = path.basename(outputPath);

  await mkdir(outputDirectory, { recursive: true });

  // Confirm before writing schema file
  if (!skipConfirm) {
    const shouldContinue = await p.confirm({
      message: `Generate schema file: ${filename}?`,
      initialValue: true,
    });

    if (p.isCancel(shouldContinue) || !shouldContinue) {
      p.cancel("Operation cancelled");
      requestGenerateExit(0);
    }
  }

  // Write schema file
  await writeFile(outputPath, schemaCode, "utf-8");

  p.log.success(ui.line(["Created", ui.path(outputPath)]));
}
