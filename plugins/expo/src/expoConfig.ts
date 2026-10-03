import { createRequire } from "node:module";
import path from "node:path";

import type * as ExpoConfig from "expo/config";

const require = createRequire(import.meta.url);

export const getConfig = async (
  ...args: Parameters<typeof ExpoConfig.getConfig>
): Promise<ReturnType<typeof ExpoConfig.getConfig>> => {
  const expoConfig: typeof ExpoConfig = require(
    require.resolve("expo/config", { paths: [path.resolve(args[0])] }),
  );
  return expoConfig.getConfig(...args);
};
