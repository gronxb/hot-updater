import {
  type Migrator,
  type SchemaGenerator,
  toolingTargetOf,
} from "@hot-updater/plugin-core";

import type { RuntimeHotUpdaterAPI } from "./createHotUpdaterCore";

type Definition = Pick<RuntimeHotUpdaterAPI, "database" | "plugins">;

/**
 * The migrator `hot-updater db migrate` runs for a server definition: core's
 * tables and its plugins' tables.
 */
export const createMigrator = ({ database, plugins }: Definition): Migrator =>
  database.createMigrator!(toolingTargetOf(plugins));

/** The schema file `hot-updater db generate` writes for a server definition. */
export const generateSchema = (
  { database, plugins }: Definition,
  version: Parameters<SchemaGenerator>[0],
  name?: Parameters<SchemaGenerator>[1],
): ReturnType<SchemaGenerator> =>
  database.generateSchema!(version, name, toolingTargetOf(plugins));
