import { createStorageOperationContext } from "@hot-updater/core/config";
import { StoragePluginError } from "@hot-updater/plugin-core/storage";

type EdgeStorageContextInput = Readonly<{
  target: "worker" | "edge";
  environment: Readonly<Record<string, string | undefined>>;
  bindings?: Readonly<Record<string, unknown>>;
}>;

export const createEdgeStorageContext = (input: EdgeStorageContextInput) => {
  if (input.target !== "worker" && input.target !== "edge") {
    throw new StoragePluginError(
      "invalid-input",
      'Edge storage context target must be "worker" or "edge".',
    );
  }
  return createStorageOperationContext({
    target: input.target,
    environment: input.environment,
    bindings: input.bindings ?? {},
  });
};
