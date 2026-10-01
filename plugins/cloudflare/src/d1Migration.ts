import { coreTarget } from "@hot-updater/plugin-core";
import type { ToolingTarget } from "@hot-updater/plugin-core";

import { d1SchemaSql } from "./d1Schema";

/**
 * A Wrangler migration of `target`'s tables and settings rows. It is named
 * after the time, since Wrangler applies migrations in the order of their
 * leading numbers, and every statement can run again. Internal: the package
 * exports what the managed Worker's runtime module offers too.
 */
export const d1Migration = (target: ToolingTarget = coreTarget) => {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return {
    code: d1SchemaSql(target),
    path: `migrations/${timestamp}_hot-updater.sql`,
  };
};
