import type { DatabaseAdapter, StorageAdapter, AdapterCompatibility } from "./adapters";

export function validateAdapterCompatibility(
  database: DatabaseAdapter,
  storage: StorageAdapter
): AdapterCompatibility {
  const warnings: string[] = [];
  const errors: string[] = [];
  
  // 1. Check dependency compatibility if specified
  if (database.dependencies && database.dependencies.length > 0) {
    if (!database.dependencies.includes(storage.name)) {
      errors.push(
        `Database adapter '${database.name}' is not compatible with storage adapter '${storage.name}'. ` +
        `Compatible storage adapters: ${database.dependencies.join(', ')}`
      );
    }
  }
  
  // 2. Add informational warning for optimal combinations
  const optimalCombinations = [
    { db: 'd1', storage: 'r2' },
    { db: 'supabase', storage: 'supabase-storage' },
    { db: 'firestore', storage: 'firebase-storage' },
    { db: 'cloudfront', storage: 'cloudfront' }
  ];
  
  const isOptimalCombination = optimalCombinations.some(
    combo => combo.db === database.name && combo.storage === storage.name
  );
  
  if (!isOptimalCombination && !errors.length) {
    warnings.push(
      `Using mixed providers (${database.name} + ${storage.name}). ` +
      `While supported, consider using matching providers for optimal performance.`
    );
  }
  
  return {
    compatible: errors.length === 0,
    warnings,
    errors
  };
}