import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";
import { unsupportedSchemaUpgradeMessage } from "./fixedMigratorShared";
import type { Migrator } from "./types";

/** A schema setting the fence found missing or different. */
export interface SchemaSettingMismatch {
  readonly key: string;
  readonly expected: string;
  readonly found: string | null;
}

const settingMessage = (
  adapterName: string,
  { key, expected, found }: SchemaSettingMismatch,
) =>
  `Hot Updater schema setting "${key}" for ${adapterName} is ${found === null ? "missing" : `"${found}"`}; expected "${expected}". ${
    key === "schema.engine"
      ? "Create a new empty database and run `hot-updater db migrate`; databases from before the storage engine are not converted."
      : "Run `hot-updater db migrate`."
  }`;

export class HotUpdaterSchemaMigrationRequiredError extends Error {
  constructor(
    readonly adapterName: string,
    readonly currentVersion: string | undefined,
    readonly setting?: SchemaSettingMismatch,
    options?: ErrorOptions,
  ) {
    super(
      setting !== undefined
        ? settingMessage(adapterName, setting)
        : currentVersion === undefined
          ? `Hot Updater database schema is not initialized for ${adapterName}. Run \`hot-updater db migrate\` before using this adapter.`
          : unsupportedSchemaUpgradeMessage(currentVersion),
      options,
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
