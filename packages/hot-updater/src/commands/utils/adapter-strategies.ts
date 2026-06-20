import { p } from "@hot-updater/cli-tools";

import { ui } from "../../utils/cli-ui";

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
