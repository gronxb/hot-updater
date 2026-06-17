import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";
import type { Migrator } from "./types";

export class HotUpdaterSchemaMigrationRequiredError extends Error {
  constructor(
    readonly adapterName: string,
    readonly currentVersion: string | undefined,
  ) {
    super(
      currentVersion === undefined
        ? `Hot Updater database schema is not initialized for ${adapterName}. Run \`hot-updater db migrate\` before using this adapter.`
        : `Hot Updater database schema version ${currentVersion} is not supported by ${adapterName}. Run \`hot-updater db migrate\` to upgrade to ${HOT_UPDATER_SCHEMA_VERSION}.`,
    );
    this.name = "HotUpdaterSchemaMigrationRequiredError";
  }
}

export const createSchemaReadinessChecker = (
  adapterName: string,
  createMigrator: (() => Migrator) | undefined,
): (() => Promise<void>) => {
  if (!createMigrator) return async () => {};

  let ready = false;
  return async () => {
    if (ready) return;
    const version = await createMigrator().getVersion();
    if (version !== HOT_UPDATER_SCHEMA_VERSION) {
      throw new HotUpdaterSchemaMigrationRequiredError(adapterName, version);
    }
    ready = true;
  };
};
