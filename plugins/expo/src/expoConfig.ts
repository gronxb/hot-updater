import type * as ExpoConfig from "expo/config";

type ExpoConfigModule = Partial<typeof ExpoConfig> & {
  default?: typeof ExpoConfig;
};

const importExpoConfigModule = (specifier: string) =>
  import(specifier) as Promise<ExpoConfigModule>;

const isMissingModule = (error: unknown, specifier: string): boolean =>
  error instanceof Error &&
  "code" in error &&
  error.code === "ERR_MODULE_NOT_FOUND" &&
  error.message.includes(specifier);

const loadExpoConfig = async (): Promise<typeof ExpoConfig> => {
  try {
    const module = await importExpoConfigModule("expo/config.js");
    return module.getConfig ? (module as typeof ExpoConfig) : module.default!;
  } catch (error) {
    if (!isMissingModule(error, "expo/config.js")) throw error;
  }

  const module = await importExpoConfigModule("expo/config/index.js");
  return module.getConfig ? (module as typeof ExpoConfig) : module.default!;
};

export const getConfig = async (
  ...args: Parameters<typeof ExpoConfig.getConfig>
): Promise<ReturnType<typeof ExpoConfig.getConfig>> => {
  const expoConfig = await loadExpoConfig();
  return expoConfig.getConfig(...args);
};
