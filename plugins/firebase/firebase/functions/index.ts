import { createHotUpdater } from "@hot-updater/server";

import {
  firebaseDatabase,
  firebaseStorage,
  plugins,
  serveManagedFunction,
} from "./managed";

export { HOT_UPDATER_BASE_PATH } from "./managed";

/**
 * The prebuilt function: the package's server, on the function's own
 * project and default bucket. A project that edits its server definition
 * gets the same runtime module around its own.
 */
export const hot = serveManagedFunction(
  createHotUpdater({
    database: firebaseDatabase(),
    storage: [firebaseStorage()],
    plugins,
  }),
);
