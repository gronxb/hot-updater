import type { Bundle } from "@hot-updater/protocol";
import { stripBundleArtifactMetadata } from "@hot-updater/protocol";

import { DatabaseAdapterInputError } from "./databaseErrors";
import { isDatabaseMetadataObject } from "./databaseJsonValue";
import type { DatabaseBundleMetadata } from "./types";

export const bundleMetadataToRow = (
  metadata: Bundle["metadata"],
): DatabaseBundleMetadata => {
  const value = stripBundleArtifactMetadata(metadata);
  if (value === undefined) return {};
  if (!isDatabaseMetadataObject(value)) {
    throw new DatabaseAdapterInputError("invalid-data");
  }
  return value;
};
