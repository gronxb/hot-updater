import type { Bundle } from "@hot-updater/protocol";

import { DatabaseAdapterInputError } from "./databaseErrors";
import { isDatabaseMetadataObject } from "./databaseJsonValue";
import type { DatabaseBundleMetadata } from "./types";

export const bundleMetadataToRow = (
  metadata: Bundle["metadata"],
): DatabaseBundleMetadata => {
  if (metadata === undefined) return {};
  if (!isDatabaseMetadataObject(metadata)) {
    throw new DatabaseAdapterInputError("invalid-data");
  }
  return metadata;
};
