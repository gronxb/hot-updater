import {
  type AssembledServer,
  assembleServer,
  createMigrator as createHotUpdaterMigrator,
  fillReleaseLabels,
  loadConfig,
  p,
  ServerDefinitionError,
} from "@hot-updater/cli-tools";
import { isRemoteDatabase } from "@hot-updater/plugin-core";

import { ui } from "../utils/cli-ui";
import { canPrompt } from "../utils/prompt";
import { scaffoldUpgradeOf } from "./doctor/context";
import { readManagedDeployment } from "./doctor/managed";
import { findScaffoldDeployments } from "./doctor/scaffoldRecords";
import { pendingResolution } from "./doctor/schema";
import {
  findDefaultConfigPaths,
  loadHotUpdater,
} from "./utils/load-hot-updater";

export interface MigrateOptions {
  configPath: string;
  skipConfirm?: boolean;
}

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

interface CustomOperation extends MigrationOperation {
  description?: string;
  type: "custom";
  key?: string;
  sql?: string;
  value?: unknown;
}

/**
 * Format migration operations into human-readable changes
 */
export function formatOperations(operations: MigrationOperation[]): string[] {
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
                `    ${ui.platform(paddedName)}  ${ui.warning(col.type)}`,
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

      case "custom": {
        const customOp = op as CustomOperation;
        if (customOp.description) {
          changes.push(customOp.description);
        } else if (customOp.sql) {
          changes.push(`Run SQL: ${customOp.sql}`);
        } else if (customOp.key) {
          changes.push(
            `Set setting: ${customOp.key}=${String(customOp.value)}`,
          );
        }
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

    const { hotUpdater, fromConfig } = await loadMigrationServer(configPath);

    // Without a server file, the server is deployed apart from this project,
    // such as init's or a scaffold's: migrating here would leave it on an
    // older schema, so only the release labels are filled.
    if (fromConfig) {
      await fillLabels(hotUpdater, s, () => deployedServerPending(hotUpdater));
      return;
    }

    // Every database on the storage engine migrates through its migrator:
    // drizzle-kit and Prisma apply their tables, so theirs set what the ORM
    // cannot declare and write the settings rows; any other adapter creates
    // core's tables and the plugins' tables itself. A database without one,
    // whose migration files apply the schema, gets only its release labels.
    await migrateWithMigrator(hotUpdater, skipConfirm, s);
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

const SERVER_MIGRATES_ITSELF =
  "The server migrates its own database: run `hot-updater db migrate` in its project as you deploy it.";

type MigrationServer = Pick<AssembledServer, "core" | "database" | "plugins">;

/**
 * The server whose database to migrate: the server file given, else a server
 * project's `src/hotUpdater.*` or `src/db.*`, else the database and plugins
 * in hot-updater.config.ts, as the CLI runs them (`fromConfig`): a managed
 * or agent infrastructure project has no server file.
 */
const loadMigrationServer = async (
  configPath: string,
): Promise<{ hotUpdater: MigrationServer; fromConfig: boolean }> => {
  if (
    configPath.trim() === "" &&
    findDefaultConfigPaths(process.cwd()).length === 0
  ) {
    const { database, plugins } = await loadConfig(null);
    if (database !== undefined) {
      return {
        hotUpdater: assembleServer({ database, plugins }),
        fromConfig: true,
      };
    }
  }
  return {
    hotUpdater: (await loadHotUpdater(configPath)).hotUpdater,
    fromConfig: false,
  };
};

/**
 * Why the config's database is not migrated here, and what migrates it with
 * its server: doctor's command for a pending schema, such as init's.
 */
const deployedServerPending = async ({
  database,
  plugins,
}: MigrationServer): Promise<string> => {
  if (isRemoteDatabase(database)) return SERVER_MIGRATES_ITSELF;
  const cwd = process.cwd();
  const { resolution } = pendingResolution(
    { database },
    {
      managed: await readManagedDeployment(cwd, database, plugins),
      scaffold: await scaffoldUpgradeOf({ database, plugins }, () =>
        findScaffoldDeployments(cwd),
      ),
    },
  );
  return `The schema is behind this CLI, and its server must migrate with it. ${resolution}`;
};

/**
 * The release labels, once the schema is current; otherwise `pending`'s
 * next step: a database whose migration files apply its schema, such as
 * Supabase's, or a server deployed apart from this project.
 */
async function fillLabels(
  hotUpdater: MigrationServer,
  s: ReturnType<typeof p.spinner>,
  pending: () => Promise<string>,
) {
  try {
    await hotUpdater.core.ready();
  } catch (error) {
    s.stop("Analysis complete");
    if (
      error instanceof Error &&
      error.name === "HotUpdaterSchemaMigrationRequiredError"
    ) {
      throw new Error(await pending());
    }
    throw error;
  }
  s.stop("Analysis complete");
  p.log.success("Schema is up to date.");
  await fillReleaseLabels(hotUpdater);
  process.exit(0);
}

/**
 * Run migrations using createMigrator (for kysely/mongodb)
 */
async function migrateWithMigrator(
  hotUpdater: MigrationServer,
  skipConfirm: boolean,
  s: ReturnType<typeof p.spinner>,
) {
  const { database, plugins } = hotUpdater;
  // A self-hosted server, through its admin API, migrates its own database.
  if (isRemoteDatabase(database)) {
    return fillLabels(hotUpdater, s, async () => SERVER_MIGRATES_ITSELF);
  }
  let migrator: ReturnType<typeof createHotUpdaterMigrator>;
  try {
    migrator = createHotUpdaterMigrator({ database, plugins });
  } catch (error) {
    if (!(error instanceof ServerDefinitionError)) throw error;
    const { message } = error;
    return fillLabels(hotUpdater, s, async () => message);
  }

  // Get current version
  const currentVersion = await migrator.getVersion();

  // Generate migration to check what changes will be made
  const result = await migrator.migrateToLatest({
    updateSettings: true,
  });

  s.stop("Analysis complete");

  // Show current version after analysis
  p.log.message(
    ui.block("Migration", [
      ui.kv("Current", currentVersion ? ui.version(currentVersion) : "empty"),
    ]),
  );

  // Check if there are any operations to perform
  const operations = (result as { operations?: MigrationOperation[] })
    .operations;

  // Format operations into human-readable changes; operations that produce
  // no change leave the schema up to date.
  const changes = formatOperations(operations ?? []);
  if (changes.length === 0) {
    p.log.success("Schema is up to date.");
    // Releases a server of an earlier release still writes need labels too.
    await fillReleaseLabels(hotUpdater);
    process.exit(0);
  }

  p.log.message(
    ui.block(
      "Changes",
      changes.map((change) => `    ${change}`),
    ),
  );

  // Confirmation
  if (!skipConfirm) {
    if (!canPrompt("Apply these changes?")) process.exit(1);
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
  p.log.success(ui.line(["Migrated to", ui.version(newVersion)]));
  await fillReleaseLabels(hotUpdater);

  // Exit process to ensure all connections are closed
  // This is especially important for MongoDB and other databases
  // that may keep connections open
  process.exit(0);
}
