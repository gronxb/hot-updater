import type {
  ConsoleAuthAdapter,
  HotUpdaterConsoleConfig,
  HotUpdaterConsoleConfigSource,
} from "../../index";

export const getConsoleAuthAdapter = async (): Promise<ConsoleAuthAdapter> => {
  const module = await import("virtual:hot-updater-console/auth");
  return module.default;
};

export const resolveConsoleConfig = async (
  request: Request,
): Promise<HotUpdaterConsoleConfig> => {
  const { default: source } =
    (await import("virtual:hot-updater-console/config")) as {
      readonly default: HotUpdaterConsoleConfigSource;
    };

  const config = typeof source === "function" ? await source(request) : source;
  return {
    console: config.console,
    database: config.database,
    storage: config.storage,
    ...(config.plugins === undefined ? {} : { plugins: config.plugins }),
  };
};
