import type { EngineDatabase } from "@hot-updater/plugin-core";

import type { SchemaSettings } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";

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

/**
 * The tables `db migrate` and `db generate` create and the settings rows they
 * write: the built-in ones, and each third-party plugin's the server runs.
 */
export interface ToolingTarget {
  readonly schema: ResolvedSchema;
  readonly settings: SchemaSettings;
}

export type SchemaGenerator = (
  version: string | "latest",
  name?: string,
  target?: ToolingTarget,
) => {
  code: string;
  path: string;
};

/**
 * What `hot-updater db generate` and `db migrate` run for a provider's
 * database, beside the database itself. Without a target they cover the
 * built-in tables.
 */
export interface DatabaseTooling {
  readonly provider?: ORMProvider;
  readonly createMigrator?: (target?: ToolingTarget) => Migrator;
  readonly generateSchema?: SchemaGenerator;
}

/** A provider's database on the storage engine, with its tooling. */
export type ToolingDatabase = EngineDatabase & DatabaseTooling;
