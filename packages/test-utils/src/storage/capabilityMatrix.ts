import {
  StoragePluginError,
  type StorageOperationContext,
  type StoragePlugin,
} from "@hot-updater/plugin-core/storage";

export {
  STORAGE_V2_PROVIDER_MATRIX,
  STORAGE_V2_PROVIDER_MATRIX_DOCUMENT,
  STORAGE_V2_PROVIDER_MATRIX_FIXTURE,
} from "./capabilityMatrixSerialization";
export type {
  StorageCapability,
  StorageOwnership,
  StorageProviderMatrixCell,
  StorageRuntimeObservation,
} from "./capabilityMatrixTypes";
export { validateStorageProviderMatrix } from "./capabilityMatrixValidation";

export const requestUnclaimedStorageCapability = <
  TContext extends StorageOperationContext,
>(
  plugin: StoragePlugin<TContext>,
  capability: "issueDownload" | "list",
): never => {
  if (plugin[capability] !== undefined) {
    throw new TypeError(
      `${capability} is present and must be invoked directly.`,
    );
  }
  throw new StoragePluginError(
    "unsupported",
    `Storage capability ${capability} is unsupported.`,
  );
};
