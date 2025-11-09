import { colors, p } from "@hot-updater/cli-tools";
import type { Migrator } from "@hot-updater/server";
import {
  showMigrateUnsupportedError,
  validateMigratorSupport,
} from "./utils/adapter-strategies";
import { loadHotUpdater } from "./utils/load-hot-updater";

export interface MigrateOptions {
  configPath: string;
  skipConfirm?: boolean;
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
                `    ${colors.cyan(paddedName)}  ${colors.yellow(col.type)}`,
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

  try {
    // Start spinner early to show progress during config loading
    const s = p.spinner();
    s.start("Loading configuration and analyzing schema");

    // Load hotUpdater instance from config file
    const { hotUpdater, adapterName } = await loadHotUpdater(configPath);

    // Execute migration based on adapter type
    switch (adapterName) {
      case "kysely":
      case "mongodb":
        // Use createMigrator to run migrations
        await migrateWithMigrator(hotUpdater, skipConfirm, s);
        break;

      case "drizzle":
      case "prisma":
        // These adapters have their own migration systems
        s.stop("Migration not supported");
        showMigrateUnsupportedError(adapterName);
        break;

      default:
        p.log.error(
          `Unsupported adapter: ${adapterName}. Migration is not supported.`,
        );
        process.exit(1);
        break;
    }
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

/**
 * Run migrations using createMigrator (for kysely/mongodb)
 */
async function migrateWithMigrator(
  hotUpdater: { createMigrator?: () => Migrator; adapterName: string },
  skipConfirm: boolean,
  s: ReturnType<typeof p.spinner>,
) {
  validateMigratorSupport(hotUpdater, hotUpdater.adapterName);

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
    process.exit(0);
  }

  // Format operations into human-readable changes
  const changes = formatOperations(operations);

  // Double-check: if operations exist but produce no changes, schema is up to date
  if (changes.length === 0) {
    p.log.info("No changes needed - schema is up to date");
    process.exit(0);
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

  // Exit process to ensure all connections are closed
  // This is especially important for MongoDB and other databases
  // that may keep connections open
  process.exit(0);
}
