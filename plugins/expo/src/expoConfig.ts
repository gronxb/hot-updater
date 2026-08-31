import { createRequire } from "node:module";
import path from "node:path";

import type * as ExpoConfig from "expo/config";

export const getConfig = (
  ...args: Parameters<typeof ExpoConfig.getConfig>
): ReturnType<typeof ExpoConfig.getConfig> => {
  const [projectRoot] = args;
  const require = createRequire(path.resolve(projectRoot, "package.json"));
  const expoConfig = require("expo/config") as typeof ExpoConfig;
  return expoConfig.getConfig(...args);
};
