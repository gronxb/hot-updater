import { createRequire } from "node:module";
import path from "node:path";

import type * as ExpoConfig from "expo/config";
import type * as ExpoConfigPlugins from "expo/config-plugins";

const require = createRequire(import.meta.url);

export const getConfig = async (
  ...args: Parameters<typeof ExpoConfig.getConfig>
): Promise<ReturnType<typeof ExpoConfig.getConfig>> => {
  const expoConfig: typeof ExpoConfig = require(
    require.resolve("expo/config", { paths: [path.resolve(args[0])] }),
  );
  return expoConfig.getConfig(...args);
};

/** The project's own `expo/config-plugins`, which prebuild writes with. */
export const getConfigPlugins = (cwd: string): typeof ExpoConfigPlugins =>
  require(
    require.resolve("expo/config-plugins", { paths: [path.resolve(cwd)] }),
  );
