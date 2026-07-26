import { StoragePluginError } from "../storage";
import type { StorageOperationContext } from "../types/storage";

type NodeStorageContextInput = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  bindings?: Readonly<Record<string, unknown>>;
}>;

export const createNodeStorageContext = (
  input: NodeStorageContextInput,
): StorageOperationContext => {
  if (
    input.bindings !== undefined &&
    Object.keys(input.bindings).length !== 0
  ) {
    throw new StoragePluginError(
      "invalid-input",
      "Node storage context bindings must be empty.",
    );
  }

  return Object.freeze({
    target: "node",
    environment: Object.freeze({ ...input.environment }),
    bindings: Object.freeze({}),
  });
};
