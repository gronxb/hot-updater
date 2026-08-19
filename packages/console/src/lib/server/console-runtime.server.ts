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

  return typeof source === "function" ? source(request) : source;
};
