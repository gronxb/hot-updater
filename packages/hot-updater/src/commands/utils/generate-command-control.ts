import { p } from "@hot-updater/cli-tools";
import type { Migrator, SchemaGenerator } from "@hot-updater/server/node";

import type { HotUpdaterInstance } from "./load-hot-updater";

export class GenerateExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

export const requestGenerateExit = (code: number): never => {
  throw new GenerateExit(code);
};

export function ensureMigratorSupport(
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
    requestGenerateExit(1);
  }
}

export function ensureSchemaGeneratorSupport(
  hotUpdater: HotUpdaterInstance,
  adapterName: string,
): asserts hotUpdater is HotUpdaterInstance & {
  generateSchema: SchemaGenerator;
} {
  if (
    !("generateSchema" in hotUpdater) ||
    typeof hotUpdater.generateSchema !== "function"
  ) {
    p.log.error(`${adapterName}: generateSchema() is required.`);
    requestGenerateExit(1);
  }
}
