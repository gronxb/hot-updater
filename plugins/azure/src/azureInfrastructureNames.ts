/** The Cosmos DB database `hot-updater init` creates. */
export const AZURE_COSMOS_V1_DATABASE = "hot-updater";

/**
 * The one container the storage engine keeps every item in. It namespaces
 * the data, so item partitions are table names with no prefix.
 */
export const AZURE_COSMOS_V1_CONTAINER = "hot_updater_v1";

/** The Blob container `hot-updater init` creates for the bundles. */
export const AZURE_BLOB_V1_CONTAINER = "hot-updater";
