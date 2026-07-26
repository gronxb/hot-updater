import fs from "fs/promises";
import path from "path";

const HOT_UPDATER_ENV_PATH = ".env.hotupdater";

const unquoteEnvValue = (value: string) => {
  const trimmed = value.trim();
  const hasMatchingQuotes =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));

  return hasMatchingQuotes ? trimmed.slice(1, -1) : trimmed;
};

export const readHotUpdaterEnv = async (
  cwd: string,
): Promise<Readonly<Record<string, string>>> => {
  let content: string;
  try {
    content = await fs.readFile(path.join(cwd, HOT_UPDATER_ENV_PATH), "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      content = "";
    } else {
      throw error;
    }
  }
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

export const getHotUpdaterEnvValue = (
  env: Readonly<Record<string, string>>,
  key: string,
) => {
  const value = process.env[key]?.trim() || env[key]?.trim();
  return value || undefined;
};
