export interface MongoMigrationBackend {
  ensureCollections(): Promise<void>;
  ensureIndexes(): Promise<void>;
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
  await backend.ensureIndexes();
  if (updateSettings) await backend.updateVersion();
};
