import { dynamoDB, plugins, s3Storage } from "@hot-updater/aws";
import { createHotUpdater } from "@hot-updater/server";

import { config } from "./config";

export const hotUpdater = createHotUpdater({
  database: dynamoDB(config),
  plugins,
  storage: [s3Storage(config)],
});
