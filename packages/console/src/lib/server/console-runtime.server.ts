import path from "node:path";

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
  const provider =
    typeof signing === "object" && signing !== null
      ? Reflect.get(signing, "provider")
      : undefined;
  const providerName =
    typeof provider === "string"
      ? provider
      : (readString(provider, "name") ?? readString(signing, "name"));
  if (providerName?.trim()) return providerName.trim().slice(0, 80);
  return readString(signing, "privateKeyPath")
    ? "Local file"
    : "Configured provider";
};

const deriveLegacyPublicKeyPath = (
  privateKeyPath: string | undefined,
): string | undefined => {
  if (
    privateKeyPath === undefined ||
    path.basename(privateKeyPath) !== "private-key.pem"
  ) {
    return undefined;
  }
  return path.join(path.dirname(privateKeyPath), "public-key.pem");
};

export const sanitizeConsoleSigningConfig = (
  signing: unknown,
): ConsoleSigningConfig | undefined => {
  if (typeof signing !== "object" || signing === null) return undefined;
  const enabled = Reflect.get(signing, "enabled") === true;
  if (!enabled) return { enabled: false };

  const publicKeyPath =
    readString(signing, "publicKeyPath") ??
    deriveLegacyPublicKeyPath(readString(signing, "privateKeyPath"));
  return {
    enabled: true,
    provider: getProviderName(signing),
    ...(publicKeyPath === undefined ? {} : { publicKeyPath }),
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
