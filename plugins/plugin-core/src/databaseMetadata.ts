import type { Bundle } from "@hot-updater/core";
import { stripBundleArtifactMetadata } from "@hot-updater/core";

import { isDatabaseMetadataObject } from "./databaseJsonValue";
import { DatabasePluginInputError } from "./databaseErrors";
import type { DatabaseBundleMetadata } from "./types";

export const bundleMetadataToRow = (
  metadata: Bundle["metadata"],
): DatabaseBundleMetadata => {
  const value = stripBundleArtifactMetadata(metadata);
  if (value === undefined) return {};
  if (!isDatabaseMetadataObject(value)) {
    throw new DatabasePluginInputError("invalid-data");
  }
  return value;
};
