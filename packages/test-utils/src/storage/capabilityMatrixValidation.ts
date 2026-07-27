import { STORAGE_V2_PROVIDER_MATRIX } from "./capabilityMatrixData";

export const validateStorageProviderMatrix = (cells: unknown): void => {
  if (JSON.stringify(cells) !== JSON.stringify(STORAGE_V2_PROVIDER_MATRIX)) {
    throw new TypeError(
      "Storage provider matrix does not match the canonical data.",
    );
  }
};
