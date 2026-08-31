import type {
  ConsoleAuthAdapter,
  ConsoleSigningConfig,
  HotUpdaterConsoleConfigSource,
  ResolvedHotUpdaterConsoleConfig,
} from "../../index";

const readString = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const member = Reflect.get(value, key);
  return typeof member === "string" && member.trim().length > 0
    ? member.trim()
    : undefined;
};

const getProviderName = (signing: unknown): string => {
  return (
    readString(signing, "name")?.slice(0, 80) ??
    (readString(signing, "privateKeyPath") ? "localSigning" : undefined) ??
    "Configured provider"
  );
};

export const sanitizeConsoleSigningConfig = (
  signing: unknown,
): ConsoleSigningConfig | undefined => {
  if (typeof signing !== "object" || signing === null) return undefined;
  const privateKeyPath = readString(signing, "privateKeyPath");
  if (
    Reflect.get(signing, "enabled") === false ||
    (privateKeyPath && Reflect.get(signing, "enabled") !== true)
  )
    return undefined;

  return {
    enabled: true,
    provider: getProviderName(signing),
  };
};

export const getConsoleAuthAdapter = async (): Promise<ConsoleAuthAdapter> => {
  const module = await import("virtual:hot-updater-console/auth");
  return module.default;
};

export const resolveConsoleConfig = async (
  request: Request,
): Promise<ResolvedHotUpdaterConsoleConfig> => {
  const { default: source } =
    (await import("virtual:hot-updater-console/config")) as {
      readonly default: HotUpdaterConsoleConfigSource;
    };

  const config = typeof source === "function" ? await source(request) : source;
  const { signing: signingSource, ...configWithoutSigning } = config;
  const signing = sanitizeConsoleSigningConfig(signingSource);
  return {
    ...configWithoutSigning,
    ...(signing === undefined ? {} : { signing }),
  };
};
