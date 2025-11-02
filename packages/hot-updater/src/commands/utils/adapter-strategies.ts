import * as p from "@clack/prompts";
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
): void {
  if (
    !("createMigrator" in hotUpdater) ||
    typeof hotUpdater.createMigrator !== "function"
  ) {
    p.log.error(
      `The ${adapterName} adapter does not support the createMigrator() method. ` +
        "This is required for SQL-based migrations.",
    );
    process.exit(1);
  }
}

/**
 * Validate that hotUpdater has the generateSchema method
 */
export function validateSchemaGeneratorSupport(
  hotUpdater: HotUpdaterInstance,
  adapterName: string,
): void {
  if (
    !("generateSchema" in hotUpdater) ||
    typeof hotUpdater.generateSchema !== "function"
  ) {
    p.log.error(
      `The ${adapterName} adapter does not support the generateSchema() method. ` +
        "Schema generation is not available for this adapter.",
    );
    process.exit(1);
  }
}

/**
 * Show error message for unsupported migrate operation
 */
export function showMigrateUnsupportedError(adapterName: string): never {
  let errorMessage = `The migrate command is not supported for the ${adapterName} adapter.\n\n`;

  switch (adapterName as AdapterName) {
    case "drizzle":
      errorMessage +=
        "For Drizzle, please use Drizzle's migration system:\n" +
        "  • Generate migration: npx drizzle-kit generate\n" +
        "  • Apply migration: npx drizzle-kit migrate\n" +
        "  • Or push directly: npx drizzle-kit push\n\n" +
        "Learn more: https://orm.drizzle.team/docs/migrations";
      break;

    case "prisma":
      errorMessage +=
        "For Prisma, please use Prisma's migration system:\n" +
        "  • Create migration: npx prisma migrate dev\n" +
        "  • Apply migration: npx prisma migrate deploy\n\n" +
        "Learn more: https://www.prisma.io/docs/concepts/components/prisma-migrate";
      break;

    case "typeorm":
      errorMessage +=
        "For TypeORM, please use TypeORM's migration system:\n" +
        "  • Generate migration: npx typeorm migration:generate\n" +
        "  • Run migration: npx typeorm migration:run\n\n" +
        "Learn more: https://typeorm.io/migrations";
      break;

    default:
      errorMessage +=
        "This adapter has its own migration system.\n" +
        "Please refer to the adapter's documentation for migration instructions.";
  }

  p.log.error(errorMessage);
  process.exit(1);
}
