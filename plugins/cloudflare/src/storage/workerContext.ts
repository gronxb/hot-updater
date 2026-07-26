import { StoragePluginError } from "@hot-updater/plugin-core/storage";
import type { StorageOperationContext } from "@hot-updater/plugin-core/storage";

type WorkerStorageContextInput<TBindings extends Record<string, unknown>> =
  Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
    bindings: Readonly<TBindings>;
  }>;

export const createWorkerStorageContext = <
  TBindings extends Record<string, unknown>,
>(
  input: WorkerStorageContextInput<TBindings>,
): StorageOperationContext<TBindings> => {
  for (const value of Object.values(input.environment)) {
    if (typeof value !== "string" && value !== undefined) {
      throw new StoragePluginError(
        "invalid-input",
        "Worker storage environment values must be strings.",
      );
    }
  }

  return Object.freeze({
    target: "worker",
    environment: Object.freeze({ ...input.environment }),
    bindings: Object.freeze({ ...input.bindings }),
  });
};
