import fs from "fs/promises";
import path from "path";

import { InitEnvFileError } from "./initOptions";

const HOT_UPDATER_ENV_PATH = ".env.hotupdater";

const unquoteEnvValue = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  const hasMatchingQuotes = trimmed.startsWith("'") && trimmed.endsWith("'");

  return hasMatchingQuotes ? trimmed.slice(1, -1) : trimmed;
};

const parseEnv = (content: string): Readonly<Record<string, string>> => {
  const env: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    const key = trimmed.slice(0, separatorIndex).trim();
    if (key) {
      env[key] = unquoteEnvValue(trimmed.slice(separatorIndex + 1));
    }
  }

  return env;
};

const readEnvFile = async (
  filePath: string,
  allowMissing: boolean,
): Promise<Readonly<Record<string, string>>> => {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (allowMissing) {
        return {};
      }
      throw new InitEnvFileError(
        `Init environment file not found: ${filePath}`,
      );
    }
    throw error;
  }

  return parseEnv(content);
};

export type HotUpdaterInitEnv = {
  readonly env: Readonly<Record<string, string>>;
  readonly managedEnv: Readonly<Record<string, string>>;
};

export const readHotUpdaterInitEnv = async (
  cwd: string,
  envFile?: string,
): Promise<HotUpdaterInitEnv> => {
  const savedEnvPath = path.resolve(cwd, HOT_UPDATER_ENV_PATH);
  const savedEnv = await readEnvFile(savedEnvPath, true);

  if (!envFile) {
    return { env: savedEnv, managedEnv: savedEnv };
  }

  const inputEnvPath = path.resolve(cwd, envFile);
  if (inputEnvPath === savedEnvPath) {
    return { env: savedEnv, managedEnv: savedEnv };
  }
  const inputEnv = await readEnvFile(inputEnvPath, false);

  return {
    env: {
      ...savedEnv,
      ...inputEnv,
    },
    managedEnv: savedEnv,
  };
};

export const readHotUpdaterEnv = async (
  cwd: string,
): Promise<Readonly<Record<string, string>>> => {
  const { managedEnv } = await readHotUpdaterInitEnv(cwd);
  return managedEnv;
};

export const getHotUpdaterEnvValue = (
  env: Readonly<Record<string, string>>,
  key: string,
) => {
  if (process.env[key] !== undefined) {
    return process.env[key]?.trim() || undefined;
  }

  return env[key]?.trim() || undefined;
};
