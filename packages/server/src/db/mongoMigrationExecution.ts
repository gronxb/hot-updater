export interface MongoMigrationBackend {
  ensureCollections(): Promise<void>;
  backfillData?(): Promise<void>;
  validateData?(): Promise<void>;
  ensureIndexes(): Promise<void>;
  enforceSchema?(): Promise<void>;
  updateVersion(): Promise<void>;
}

export const executeMongoMigration = async ({
  backend,
  updateSettings,
}: {
  readonly backend: MongoMigrationBackend;
  readonly updateSettings: boolean;
}): Promise<void> => {
  await backend.ensureCollections();
  await backend.backfillData?.();
  await backend.validateData?.();
  await backend.ensureIndexes();
  await backend.enforceSchema?.();
  if (updateSettings) await backend.updateVersion();
};
