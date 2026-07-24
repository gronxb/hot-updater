import { createHash, randomBytes } from "node:crypto";
import { appendFile, chmod, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { decodeBase64Url32 } from "./base64url";

export const HOT_UPDATER_API_KEY_ENV_NAME = "HOT_UPDATER_API_KEY";

export type ProvisionApiKeyOptions = {
  readonly envFilePath?: string;
};

export type ProvisionedApiKey = {
  readonly apiKey: string;
  readonly sha256: string;
};

const envLinePattern = new RegExp(
  `^\\s*(?:export\\s+)?${HOT_UPDATER_API_KEY_ENV_NAME}\\s*=(.*)$`,
  "u",
);

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "code") === "ENOENT";

const readEnvFile = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return "";
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
    throw new Error(
      `.env.hotupdater contains multiple ${HOT_UPDATER_API_KEY_ENV_NAME} definitions.`,
    );
  }
  const value = values[0];
  if (value === undefined) return undefined;
  if (decodeBase64Url32(value) === undefined) {
    throw new Error(
      `${HOT_UPDATER_API_KEY_ENV_NAME} must be a canonical 32-byte base64url value.`,
    );
  }
  return value;
};

const digest = (apiKey: string): string =>
  createHash("sha256").update(apiKey).digest("base64url");

const resultFor = (apiKey: string): ProvisionedApiKey =>
  Object.freeze({ apiKey, sha256: digest(apiKey) });

const restrictPermissions = async (filePath: string): Promise<void> => {
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Some filesystems do not support POSIX modes.
  }
};

export const provisionApiKey = async (
  options: ProvisionApiKeyOptions = {},
): Promise<ProvisionedApiKey> => {
  const envFilePath =
    options.envFilePath ?? resolve(process.cwd(), ".env.hotupdater");
  const content = await readEnvFile(envFilePath);
  const existing = readExistingApiKey(content);
  if (existing !== undefined) return resultFor(existing);

  const apiKey = randomBytes(32).toString("base64url");
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  await appendFile(
    envFilePath,
    `${separator}${HOT_UPDATER_API_KEY_ENV_NAME}=${apiKey}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await restrictPermissions(envFilePath);
  return resultFor(apiKey);
};
