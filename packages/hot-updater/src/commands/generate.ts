import * as p from "@clack/prompts";
import type { Migrator } from "@hot-updater/server";
import { createHash } from "crypto";
import { access, mkdir, readdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { format } from "sql-formatter";
import {
  validateMigratorSupport,
  validateSchemaGeneratorSupport,
} from "./utils/adapter-strategies";
import { loadHotUpdater } from "./utils/load-hot-updater";
import { mergePrismaSchema } from "./utils/prisma-schema-merger";

export interface GenerateOptions {
  configPath: string;
  outputDir?: string;
  skipConfirm?: boolean;
}

export async function generate(options: GenerateOptions) {
  const { configPath, outputDir = undefined, skipConfirm = false } = options;

  try {
    // Start spinner early to show progress during config loading
    const s = p.spinner();
    s.start("Loading configuration and analyzing schema");

    // Load hotUpdater instance from config file
    const { hotUpdater, adapterName } = await loadHotUpdater(configPath);

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
      default:
        p.log.error(
          `Unsupported adapter: ${adapterName}. Migration is not supported.`,
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
    p.log.info("No changes needed - schema is up to date");
    return;
  }

  // Format SQL for better readability
  const formattedSql = format(sql, {
    language: "postgresql",
    tabWidth: 2,
    keywordCase: "upper",
  });

  // Create output directory
  await mkdir(absoluteOutputDir, { recursive: true });

  // Check for duplicate SQL files using MD5 hash
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

  p.log.success(`Migration file created: ${filename}`);
}

/**
 * Generate TypeScript schema files using generateSchema (for drizzle/prisma/typeorm)
 */
async function generateWithSchemaGenerator(
  hotUpdater: {
    generateSchema?: (
      version: string | "latest",
      name?: string,
    ) => {
      code: string;
      path: string;
    };
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
    p.log.info("No schema generated");
    return;
  }

  // Special handling for Prisma adapter - write directly to schema.prisma
  if (adapterName === "prisma") {
    await generatePrismaSchema(schemaCode, absoluteOutputDir, skipConfirm);
    return;
  }

  // For other adapters (drizzle, typeorm), use the original logic
  // Create output directory
  await mkdir(absoluteOutputDir, { recursive: true });

  // Check for duplicate schema files using MD5 hash
  const newSchemaHash = createHash("md5").update(schemaCode).digest("hex");

  try {
    const files = await readdir(absoluteOutputDir);
    const schemaFiles = files.filter((file) => file.endsWith(".ts"));

    for (const file of schemaFiles) {
      const filePath = path.join(absoluteOutputDir, file);
      const existingContent = await readFile(filePath, "utf-8");
      const existingHash = createHash("md5")
        .update(existingContent)
        .digest("hex");

      if (existingHash === newSchemaHash) {
        p.log.warn(
          `Identical schema already exists: ${file}\nNo new schema file created.`,
        );
        p.outro("Done");
        return;
      }
    }
  } catch {
    // Directory doesn't exist yet or can't be read, continue with file creation
  }

  // Use fixed filename for schema files
  const filename = "hot-updater-schema.ts";
  const outputPath = path.join(absoluteOutputDir, filename);

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

  p.log.success(`Schema file created: ${filename}`);
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
    schemaExists
      ? "Updated prisma/schema.prisma"
      : "Created prisma/schema.prisma",
  );
  p.log.info(
    "Next steps:\n  1. Run: npx prisma generate\n  2. Run: npx prisma migrate dev",
  );
}
