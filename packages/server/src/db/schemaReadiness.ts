import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";
import { unsupportedSchemaUpgradeMessage } from "./fixedMigratorShared";
import type { Migrator } from "./types";
import type { SchemaProvisioner } from "./types";

export class HotUpdaterSchemaMigrationRequiredError extends Error {
  constructor(
    readonly adapterName: string,
    readonly currentVersion: string | undefined,
  ) {
    super(
      currentVersion === undefined
        ? `Hot Updater database schema is not initialized for ${adapterName}. Run \`hot-updater db migrate\` before using this adapter.`
        : unsupportedSchemaUpgradeMessage(currentVersion),
    );
    this.name = "HotUpdaterSchemaMigrationRequiredError";
  }
}

export class HotUpdaterInsightsSchemaProvisioningRequiredError extends Error {
  constructor(readonly adapterName: string) {
    super(
      `Hot Updater Insights storage is not provisioned for ${adapterName}. Run \`hot-updater db migrate\` after applying the ORM schema and before starting the server.`,
    );
    this.name = "HotUpdaterInsightsSchemaProvisioningRequiredError";
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

export const createInsightsSchemaReadinessChecker = (
  adapterName: string,
  createProvisioner: (() => SchemaProvisioner) | undefined,
): (() => Promise<void>) => {
  if (!createProvisioner) return async () => {};

  let ready = false;
  return async () => {
    if (ready) return;
    const plan = await createProvisioner().plan();
    if (plan.operations.length > 0) {
      throw new HotUpdaterInsightsSchemaProvisioningRequiredError(adapterName);
    }
    ready = true;
  };
};
