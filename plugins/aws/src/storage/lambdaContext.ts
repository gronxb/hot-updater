import { createStorageOperationContext } from "@hot-updater/core/config";
import type { StorageOperationContext } from "@hot-updater/plugin-core/storage";

type LambdaStorageContextInput<TBindings extends Record<string, unknown>> =
  Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
    bindings: Readonly<TBindings>;
  }>;

export const createLambdaStorageContext = <
  TBindings extends Record<string, unknown>,
>(
  input: LambdaStorageContextInput<TBindings>,
): StorageOperationContext<TBindings> =>
  createStorageOperationContext({
    target: "functions",
    environment: input.environment,
    bindings: input.bindings,
  });
