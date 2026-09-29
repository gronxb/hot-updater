import type { EngineDatabase } from "@hot-updater/plugin-core";

export const sqlProviders = ["sqlite", "mysql", "postgresql"] as const;

export const noSqlProviders = ["mongodb"] as const;
export const providers = [...sqlProviders, ...noSqlProviders] as const;

export type ORMProvider = (typeof providers)[number];
export type ORMSQLProvider = (typeof sqlProviders)[number];

export interface MigrateOptions {
  mode?: "from-schema" | "from-database";
  updateSettings?: boolean;
  unsafe?: boolean;
}

export type MigrationOperation =
  | {
      type: "create-table";
      value: {
        ormName: string;
        columns: Record<string, { ormName: string; type: string }>;
      };
    }
  | { type: "custom"; description: string }
  | { type: "custom"; sql: string }
  | { type: "custom"; key: string; value: unknown };

export interface MigrationResult {
  operations: MigrationOperation[];
  execute: () => Promise<void>;
  getSQL?: () => string;
}

export interface Migrator {
  getVersion: () => Promise<string | undefined>;
  getNameVariants: () => Promise<unknown>;
  next: () => Promise<{ version: string } | undefined>;
  previous: () => Promise<{ version: string } | undefined>;
  up: (options?: MigrateOptions) => Promise<MigrationResult>;
  down: (options?: MigrateOptions) => Promise<MigrationResult>;
  migrateTo: (
    version: string,
    options?: MigrateOptions,
  ) => Promise<MigrationResult>;
  migrateToLatest: (options?: MigrateOptions) => Promise<MigrationResult>;
}

export type SchemaGenerator = (
  version: string | "latest",
  name?: string,
) => {
  code: string;
  path: string;
};

/**
 * What `hot-updater db generate` and `db migrate` run for a provider's
 * database, beside the database itself.
 */
export interface DatabaseTooling {
  readonly provider?: ORMProvider;
  readonly createMigrator?: () => Migrator;
  readonly generateSchema?: SchemaGenerator;
}

/** A provider's database on the storage engine, with its tooling. */
export type ToolingDatabase = EngineDatabase & DatabaseTooling;
