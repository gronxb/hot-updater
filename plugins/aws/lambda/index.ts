import { createHotUpdater } from "@hot-updater/server";

import { dynamoDB, plugins, s3Storage, serveManagedLambda } from "./managed";

export { HOT_UPDATER_BASE_PATH } from "./managed";

/**
 * The prebuilt function: the package's server, on the table and bucket init
 * set up. A project that edits its server definition gets the same runtime
 * module around its own.
 */
export const handler = serveManagedLambda(
  createHotUpdater({
    database: dynamoDB(),
    storage: [s3Storage()],
    plugins,
  }),
);
