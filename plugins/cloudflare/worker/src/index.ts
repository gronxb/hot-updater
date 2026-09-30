import { createHotUpdater } from "@hot-updater/server";

import {
  d1Database,
  plugins,
  r2Storage,
  serveManagedWorker,
} from "../../src/worker/managed";

export {
  type CloudflareWorkerEnv,
  HOT_UPDATER_BASE_PATH,
} from "../../src/worker/managed";

/** The prebuilt Worker: the server definition init writes, on the Worker's bindings. */
export default serveManagedWorker(
  createHotUpdater({ database: d1Database(), storage: [r2Storage()], plugins }),
);
