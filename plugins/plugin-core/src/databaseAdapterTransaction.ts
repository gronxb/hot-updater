import { createDatabaseAdapterCrud } from "./databaseAdapterCrud";
import type {
  DatabaseAdapterImplementation,
  TransactionDatabaseAdapter,
  TransactionDatabaseAdapterImplementation,
} from "./types";

export const createTransactionDatabaseAdapter = (
  implementation: TransactionDatabaseAdapterImplementation,
): TransactionDatabaseAdapter => {
  const adapterImplementation: DatabaseAdapterImplementation = {
    ...implementation,
  };
  return createDatabaseAdapterCrud(adapterImplementation);
};
