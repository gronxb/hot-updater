import { p } from "@hot-updater/cli-tools";
import type { Migrator } from "@hot-updater/server";

import { ui } from "../../utils/cli-ui";
import type { HotUpdaterInstance } from "./load-hot-updater";

/**
 * Adapter types
 */
export type AdapterName =
  | "kysely"
  | "drizzle"
  | "mongodb"
  | "prisma"
  | "typeorm";

/**
 * Validate that hotUpdater has the createMigrator method
 */
export function validateMigratorSupport(
  hotUpdater: HotUpdaterInstance,
  adapterName: string,
): asserts hotUpdater is HotUpdaterInstance & {
  createMigrator: () => Migrator;
} {
  if (
    !("createMigrator" in hotUpdater) ||
    typeof hotUpdater.createMigrator !== "function"
  ) {
    p.log.error(`${adapterName}: createMigrator() is required.`);
    process.exit(1);
  }
}

/**
 * Validate that hotUpdater has the generateSchema method
 */
export function validateSchemaGeneratorSupport(
  hotUpdater: HotUpdaterInstance,
  adapterName: string,
): asserts hotUpdater is HotUpdaterInstance & {
  generateSchema: (
    version: string | "latest",
    name?: string,
  ) => { code: string; path: string };
} {
  if (
    !("generateSchema" in hotUpdater) ||
    typeof hotUpdater.generateSchema !== "function"
  ) {
    p.log.error(`${adapterName}: generateSchema() is required.`);
    process.exit(1);
  }
}

/**
 * Show error message for unsupported migrate operation
 */
export function showMigrateUnsupportedError(adapterName: string): never {
  let hint = "Use the adapter's migration tool.";

  switch (adapterName as AdapterName) {
    case "drizzle":
      hint = "Use drizzle-kit.";
      break;

    case "prisma":
      hint = "Use prisma migrate.";
      break;

    case "typeorm":
      hint = "Use TypeORM migrations.";
      break;
  }

  p.log.error(
    ui.line(["migrate is not supported for", ui.warning(adapterName), hint]),
  );
  process.exit(1);
}
