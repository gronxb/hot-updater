import type { ORMProvider } from "../db/types";

export const HOT_UPDATER_SCHEMA_VERSION = "0.36.0";
export const HOT_UPDATER_SETTINGS_TABLE = "private_hot_updater_settings";

export type HotUpdaterColumnType =
  | "bool"
  | "integer"
  | "json"
  | "string"
  | "uuid"
  | `varchar(${number})`;

export type HotUpdaterDefault =
  | { readonly type: "literal"; readonly value: boolean | number | string }
  | { readonly type: "json"; readonly value: unknown };

export interface HotUpdaterColumnSchema {
  readonly ormName: string;
  readonly type: HotUpdaterColumnType;
  readonly nullable?: boolean;
  readonly primaryKey?: boolean;
  readonly default?: HotUpdaterDefault;
}

export interface HotUpdaterIndexSchema {
  readonly name: string;
  readonly columns: readonly string[];
  readonly providers?: readonly ORMProvider[];
  readonly unique?: true;
}

export interface HotUpdaterCheckSchema {
  readonly name: string;
  readonly expression: string;
  readonly sqliteInline?: boolean;
}

export interface HotUpdaterForeignKeySchema {
  readonly name: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  readonly onUpdate: "restrict";
  readonly onDelete: "cascade" | "restrict";
}

export interface HotUpdaterRelationSchema {
  readonly name: string;
  readonly fieldName: string;
  readonly targetFieldName: string;
  readonly relationName: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
}

export interface HotUpdaterTableSchema {
  readonly ormName: string;
  readonly columns: readonly HotUpdaterColumnSchema[];
  readonly indexes?: readonly HotUpdaterIndexSchema[];
  readonly checks?: readonly HotUpdaterCheckSchema[];
  readonly foreignKeys?: readonly HotUpdaterForeignKeySchema[];
  readonly relations?: readonly HotUpdaterRelationSchema[];
  readonly internal?: boolean;
}

export interface HotUpdaterVersionedSchema {
  readonly version: HotUpdaterSchemaVersion;
  readonly settingsTable: string;
  readonly tables: readonly HotUpdaterTableSchema[];
}

export type HotUpdaterSchemaVersion = "0.21.0" | "0.29.0" | "0.31.0" | "0.36.0";
