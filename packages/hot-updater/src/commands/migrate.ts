import * as p from "@clack/prompts";
import type { Migrator } from "@hot-updater/server";
import { existsSync } from "fs";
import { createJiti } from "jiti";
import path from "path";
import pc from "picocolors";

export interface MigrateOptions {
  configPath: string;
  skipConfirm?: boolean;
}

interface HotUpdaterInstance {
  createMigrator: () => Migrator;
}

/**
 * Minimal types for fumadb migration operations (not exported from fumadb)
 */
interface MigrationOperation {
  type: string;
  [key: string]: unknown;
}

interface TableOperation extends MigrationOperation {
  type: "create-table" | "drop-table" | "update-table" | "rename-table";
  name?: string;
  from?: string;
  to?: string;
  value?: { ormName?: string } | ColumnOperation[];
}

interface ColumnOperation {
  type: "create-column" | "drop-column" | "rename-column" | "update-column";
  name?: string;
  from?: string;
  to?: string;
  value?: { ormName?: string; type?: string };
}

/**
 * Format migration operations into human-readable changes
 */
function formatOperations(operations: MigrationOperation[]): string[] {
  const changes: string[] = [];

  for (const op of operations) {
    switch (op.type) {
      case "create-table": {
        const tableOp = op as TableOperation;
        const table = tableOp.value as {
          ormName?: string;
          columns?: Record<string, { ormName?: string; type?: string }>;
        };
        const tableName = table.ormName ?? "unknown";
        changes.push(`Create table: ${tableName}`);

        // Show columns with types in table format
        if (table.columns) {
          const columns = Object.values(table.columns)
            .map((col) => {
              if (!col.ormName) return null;
              return {
                name: col.ormName,
                type: col.type ?? "unknown",
              };
            })
            .filter(
              (col): col is { name: string; type: string } => col !== null,
            );

          if (columns.length > 0) {
            changes.push("  Columns:");
            // Calculate max column name length for alignment
            const maxNameLength = Math.max(
              ...columns.map((c) => c.name.length),
            );
            for (const col of columns) {
              const paddedName = col.name.padEnd(maxNameLength);
              changes.push(
                `    ${pc.cyan(paddedName)}  ${pc.yellow(col.type)}`,
              );
            }
          }
        }
        break;
      }

      case "drop-table": {
        const tableOp = op as TableOperation;
        changes.push(`Drop table: ${tableOp.name}`);
        break;
      }

      case "rename-table": {
        const tableOp = op as TableOperation;
        changes.push(`Rename table: ${tableOp.from} → ${tableOp.to}`);
        break;
      }

      case "update-table": {
        const tableOp = op as TableOperation;
        const tableName = tableOp.name;
        const columnOps = tableOp.value as ColumnOperation[];

        if (columnOps && Array.isArray(columnOps)) {
          for (const colOp of columnOps) {
            switch (colOp.type) {
              case "create-column": {
                const colName = colOp.value?.ormName ?? "unknown";
                const colType = colOp.value?.type;
                const colInfo = colType ? `${colName}: ${colType}` : colName;
                changes.push(`Add column: ${tableName}.${colInfo}`);
                break;
              }
              case "drop-column":
                changes.push(`Drop column: ${tableName}.${colOp.name}`);
                break;
              case "rename-column":
                changes.push(
                  `Rename column: ${tableName}.${colOp.from} → ${colOp.to}`,
                );
                break;
              case "update-column": {
                const colName = colOp.name;
                const colType = colOp.value?.type;
                const colInfo = colType ? `${colName}: ${colType}` : colName;
                changes.push(`Update column: ${tableName}.${colInfo}`);
                break;
              }
            }
          }
        }
        break;
      }

      case "add-foreign-key": {
        const table = (op as { table?: string }).table;
        const name = (op as { value?: { name?: string } }).value?.name;
        changes.push(`Add foreign key: ${table}.${name}`);
        break;
      }

      case "drop-foreign-key": {
        const table = (op as { table?: string }).table;
        const name = (op as { name?: string }).name;
        changes.push(`Drop foreign key: ${table}.${name}`);
        break;
      }

      case "add-unique-constraint": {
        const table = (op as { table?: string }).table;
        const name = (op as { name?: string }).name;
        changes.push(`Add unique constraint: ${table}.${name}`);
        break;
      }

      case "drop-unique-constraint": {
        const table = (op as { table?: string }).table;
        const name = (op as { name?: string }).name;
        changes.push(`Drop unique constraint: ${table}.${name}`);
        break;
      }
    }
  }

  return changes;
}

export async function migrate(options: MigrateOptions) {
  const { configPath, skipConfirm = false } = options;

  // Resolve absolute path
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);

  // Verify config file exists
  if (!existsSync(absoluteConfigPath)) {
    p.log.error(`Config file not found: ${absoluteConfigPath}`);
    process.exit(1);
  }

  try {
    // Start spinner early to show progress during config loading
    const s = p.spinner();
    s.start("Loading configuration and analyzing schema");

    // Load config file using jiti
    const jiti = createJiti(import.meta.url, { interopDefault: true });

    let moduleExports: Record<string, unknown>;
    try {
      moduleExports = (await jiti.import(absoluteConfigPath)) as Record<
        string,
        unknown
      >;
    } catch (importError) {
      s.stop("Failed to load configuration");
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
    const hotUpdater = (moduleExports["hotUpdater"] ||
      moduleExports["default"]) as HotUpdaterInstance | undefined;

    if (!hotUpdater) {
      s.stop("Configuration validation failed");
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
      s.stop("Configuration validation failed");
      p.log.error(
        "The hotUpdater instance does not have a createMigrator() method. " +
          "Please ensure you're using @hot-updater/server's createHotUpdater().",
      );
      process.exit(1);
    }

    // Create migrator
    const migrator = hotUpdater.createMigrator();

    // Get current version
    const currentVersion = await migrator.getVersion();

    // Generate migration to check what changes will be made
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });

    s.stop("Analysis complete");

    // Show current version after analysis
    p.log.info(
      currentVersion
        ? `Current version: ${currentVersion}`
        : "Database is empty (initial migration)",
    );

    // Check if there are any operations to perform
    const operations = (result as { operations?: MigrationOperation[] })
      .operations;

    if (!operations || operations.length === 0) {
      p.log.info("No changes needed - schema is up to date");
      return;
    }

    // Format operations into human-readable changes
    const changes = formatOperations(operations);

    // Double-check: if operations exist but produce no changes, schema is up to date
    if (changes.length === 0) {
      p.log.info("No changes needed - schema is up to date");
      return;
    }

    p.log.step("Changes to apply:");
    for (const change of changes) {
      p.log.info(`  ${change}`);
    }

    // Confirmation
    if (!skipConfirm) {
      const shouldContinue = await p.confirm({
        message: "Apply these changes?",
        initialValue: true,
      });

      if (p.isCancel(shouldContinue) || !shouldContinue) {
        p.cancel("Migration cancelled");
        process.exit(0);
      }
    }

    // Execute migration
    await result.execute();

    const newVersion = await migrator.getVersion();
    p.log.success(`Migrated to version ${newVersion}`);
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
