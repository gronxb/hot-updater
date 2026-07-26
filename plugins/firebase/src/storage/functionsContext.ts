import type { StorageOperationContext } from "@hot-updater/plugin-core/storage";

type FunctionsStorageContextInput<TBindings extends Record<string, unknown>> =
  Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
    bindings: Readonly<TBindings>;
  }>;

export const createFunctionsStorageContext = <
  TBindings extends Record<string, unknown>,
>(
  input: FunctionsStorageContextInput<TBindings>,
): StorageOperationContext<TBindings> =>
  Object.freeze({
    target: "functions",
    environment: Object.freeze({ ...input.environment }),
    bindings: Object.freeze({ ...input.bindings }),
  });
