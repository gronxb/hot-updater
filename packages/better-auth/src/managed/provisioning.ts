import { createHash, randomBytes } from "node:crypto";
import { appendFile, chmod, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { isCanonicalBase64Url32 } from "../base64url";

export const HOT_UPDATER_API_KEY_ENV_NAME = "HOT_UPDATER_API_KEY";

export type ProvisionManagedBetterAuthApiKeyOptions = {
  readonly envFilePath?: string;
};

export type ProvisionedManagedBetterAuthApiKey = {
  readonly apiKey: string;
  readonly sha256: string;
};

class ManagedBetterAuthProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedBetterAuthProvisioningError";
  }
}

const envLinePattern = new RegExp(
  `^\\s*(?:export\\s+)?${HOT_UPDATER_API_KEY_ENV_NAME}\\s*=(.*)$`,
  "u",
);

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "code") === "ENOENT";

type EnvFileState = {
  readonly content: string;
  readonly exists: boolean;
};

const readEnvFile = async (filePath: string): Promise<EnvFileState> => {
  try {
    return Object.freeze({
      content: await readFile(filePath, "utf8"),
      exists: true,
    });
  } catch (error) {
    if (isMissingFileError(error)) {
      return Object.freeze({ content: "", exists: false });
    }
    throw error;
  }
};

const secureEnvFile = async (filePath: string): Promise<void> => {
  await chmod(filePath, 0o600);
};

const createSecureEnvFile = async (filePath: string): Promise<void> => {
  await appendFile(filePath, "", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await secureEnvFile(filePath);
  } catch (error) {
    await rm(filePath, { force: true });
    throw error;
  }
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  const first = trimmed.at(0);
  if (
    (first === '"' || first === "'") &&
    trimmed.at(-1) === first &&
    trimmed.length >= 2
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const readExistingApiKey = (content: string): string | undefined => {
  const values = content.split(/\r?\n/u).flatMap((line) => {
    const match = envLinePattern.exec(line);
    return match === null ? [] : [unquote(match[1] ?? "")];
  });
  if (values.length > 1) {
    throw new ManagedBetterAuthProvisioningError(
      `.env.hotupdater contains multiple ${HOT_UPDATER_API_KEY_ENV_NAME} definitions.`,
    );
  }
  const value = values[0];
  if (value === undefined) return undefined;
  if (!isCanonicalBase64Url32(value)) {
    throw new ManagedBetterAuthProvisioningError(
      `${HOT_UPDATER_API_KEY_ENV_NAME} must be a canonical 32-byte base64url value.`,
    );
  }
  return value;
};

const resultFor = (apiKey: string): ProvisionedManagedBetterAuthApiKey =>
  Object.freeze({
    apiKey,
    sha256: createHash("sha256").update(apiKey).digest("base64url"),
  });

export const provisionManagedBetterAuthApiKey = async (
  options: ProvisionManagedBetterAuthApiKeyOptions = {},
): Promise<ProvisionedManagedBetterAuthApiKey> => {
  const envFilePath =
    options.envFilePath ?? resolve(process.cwd(), ".env.hotupdater");
  const { content, exists } = await readEnvFile(envFilePath);
  if (exists) {
    await secureEnvFile(envFilePath);
  } else {
    await createSecureEnvFile(envFilePath);
  }
  const existing = readExistingApiKey(content);
  if (existing !== undefined) return resultFor(existing);

  const apiKey = randomBytes(32).toString("base64url");
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  await appendFile(
    envFilePath,
    `${separator}${HOT_UPDATER_API_KEY_ENV_NAME}=${apiKey}\n`,
    { encoding: "utf8" },
  );
  return resultFor(apiKey);
};
