import { access, mkdir, readdir, readFile, writeFile } from "fs/promises";
import path from "path";

import { p } from "@hot-updater/cli-tools";
import type { Migrator, SchemaGenerator } from "@hot-updater/server";
import {
  formatDialect,
  mysql as mysqlDialect,
  postgresql as postgresqlDialect,
} from "sql-formatter";

import { ui } from "../utils/cli-ui";
import { generateStandaloneSQL } from "./generate-standalone-sql";
import {
  validateMigratorSupport,
  validateSchemaGeneratorSupport,
} from "./utils/adapter-strategies";
import { resolveGeneratedSchemaOutputPath } from "./utils/generated-schema-artifact";
import {
  type LoadHotUpdaterResult,
  loadHotUpdater,
} from "./utils/load-hot-updater";
import { mergePrismaSchema } from "./utils/prisma-schema-merger";

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
        process.exit(1);
        break;
      default:
        p.log.error(
          `Unsupported adapter: ${adapterName}. Generation is not supported.`,
        );
        process.exit(1);
        break;
    }
  } catch (error) {
    p.log.error("Failed to generate");
    if (error instanceof Error) {
      p.log.error(error.message);
      if (process.env["DEBUG"]) {
        console.error(error.stack);
      }
    }
    process.exit(1);
  } finally {
    await loadedConfig?.dispose();
  }
}

/**
 * Generate SQL migration files using createMigrator (for kysely/mongodb)
 */
async function generateWithMigrator(
  hotUpdater: { createMigrator?: () => Migrator; adapterName: string },
  absoluteOutputDir: string,
  skipConfirm: boolean,
  s: ReturnType<typeof p.spinner>,
) {
  validateMigratorSupport(hotUpdater, hotUpdater.adapterName);

  // Create migrator
  const migrator = hotUpdater.createMigrator();

  // Generate migration
  const result = await migrator.migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  });

  s.stop("Analysis complete");

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
      process.exit(0);
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
  hotUpdater: {
    generateSchema?: SchemaGenerator;
    adapterName: string;
  },
  adapterName: string,
  absoluteOutputDir: string,
  skipConfirm: boolean,
  s: ReturnType<typeof p.spinner>,
) {
  validateSchemaGeneratorSupport(hotUpdater, adapterName);

  // Generate schema
  const schemaResult = hotUpdater.generateSchema("latest");

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

  try {
    const files = await readdir(outputDirectory);
    const schemaFiles = files.filter((file) => file.endsWith(".ts"));

    for (const file of schemaFiles) {
      const filePath = path.join(outputDirectory, file);
      const existingContent = await readFile(filePath, "utf-8");

      if (existingContent === schemaCode) {
        p.log.warn(`Identical schema already exists: ${file}`);
        p.outro("Done");
        return;
      }
    }
  } catch {
    // Directory doesn't exist yet or can't be read, continue with file creation
  }

  // Confirm before writing schema file
  if (!skipConfirm) {
    const shouldContinue = await p.confirm({
      message: `Generate schema file: ${filename}?`,
      initialValue: true,
    });

    if (p.isCancel(shouldContinue) || !shouldContinue) {
      p.cancel("Operation cancelled");
      process.exit(0);
    }
  }

  // Write schema file
  await writeFile(outputPath, schemaCode, "utf-8");

  p.log.success(ui.line(["Created", ui.path(outputPath)]));
}

/**
 * Generate Prisma schema - directly modifies prisma/schema.prisma file
 * Similar to better-auth's approach
 */
async function generatePrismaSchema(
  schemaCode: string,
  outputDir: string,
  skipConfirm: boolean,
) {
  // Default Prisma schema path
  const prismaSchemaPath = path.join(outputDir, "prisma", "schema.prisma");

  // Check if prisma/schema.prisma exists
  let schemaExists = false;
  try {
    await access(prismaSchemaPath);
    schemaExists = true;
  } catch {
    // Schema file doesn't exist
  }

  let finalContent: string;
  let message: string;

  if (!schemaExists) {
    // Warn about missing generator and datasource blocks
    p.log.warn("Generated schema only contains model definitions.");

    // Use the complete schema from generateSchema for initial creation
    finalContent = schemaCode;
    message = "Create prisma/schema.prisma?";
  } else {
    // Read existing schema and merge
    const existingSchema = await readFile(prismaSchemaPath, "utf-8");
    const { content, hadExistingModels } = mergePrismaSchema(
      existingSchema,
      schemaCode,
    );
    finalContent = content;
    message = hadExistingModels
      ? "Update hot-updater models in prisma/schema.prisma?"
      : "Add hot-updater models to prisma/schema.prisma?";
  }

  // Confirm before writing
  if (!skipConfirm) {
    const shouldContinue = await p.confirm({
      message,
      initialValue: true,
    });

    if (p.isCancel(shouldContinue) || !shouldContinue) {
      p.cancel("Operation cancelled");
      process.exit(0);
    }
  }

  // Create prisma directory if it doesn't exist
  await mkdir(path.dirname(prismaSchemaPath), { recursive: true });

  // Write schema file
  await writeFile(prismaSchemaPath, finalContent, "utf-8");

  p.log.success(
    ui.line([schemaExists ? "Updated" : "Created", ui.path(prismaSchemaPath)]),
  );
  p.log.message(
    ui.block("Run", [
      ui.kv("Prisma", ui.command("npx prisma generate")),
      ui.kv("Migrate", ui.command("npx prisma migrate dev")),
    ]),
  );
}
