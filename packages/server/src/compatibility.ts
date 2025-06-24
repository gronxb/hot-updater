import type { DatabaseAdapter, StorageAdapter, CompatibilityCheck } from "./types";

export function validateAdapterCompatibility(
  database: DatabaseAdapter,
  storage: StorageAdapter,
): CompatibilityCheck {
  const errors: string[] = [];

  // Check if database has dependencies and if storage is compatible
  if (database.dependencies && database.dependencies.length > 0) {
    const isStorageCompatible = database.dependencies.includes(storage.name);
    if (!isStorageCompatible) {
      errors.push(
        `Database adapter '${database.name}' requires one of [${database.dependencies.join(', ')}] but got storage adapter '${storage.name}'`
      );
    }
  }

  return {
    compatible: errors.length === 0,
    errors,
  };
}