import fs from "node:fs/promises";
import path from "node:path";

/** The names hot-updater.config may have, as `loadConfig` looks them up. */
const CONFIG_FILES = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
  (extension) => `hot-updater.config.${extension}`,
);

/** `process.env.NAME!` and `process.env["NAME"]!`, but not `!=`. */
const ASSERTED_READ =
  /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])\s*!(?!=)/gu;

/** Where `process.env` reads are documented against `secretEnv`. */
const SECRETS_DOCS_URL = "https://hot-updater.dev/docs/concepts/secrets";

/**
 * The variables `cwd`'s hot-updater.config reads as `process.env.<name>!`,
 * asserting each is set, that the environment lacks once the config has
 * loaded: an adapter would hand `undefined` to its provider's SDK, whose
 * error names no variable. Empty without a config file.
 */
export const findUnsetConfigEnv = async (
  cwd: string,
): Promise<readonly string[]> => {
  for (const file of CONFIG_FILES) {
    const text = await fs
      .readFile(path.join(cwd, file), "utf-8")
      .catch(() => undefined);
    if (text === undefined) continue;
    const names = new Set(
      [...text.matchAll(ASSERTED_READ)].map((match) => match[1] ?? match[2]!),
    );
    return [...names].filter((name) => !process.env[name]?.trim());
  }
  return [];
};

/**
 * Refuses, before any adapter reaches its provider, a config whose
 * `process.env.<name>!` reads the environment doesn't set
 * (`findUnsetConfigEnv`), naming each and how to set it.
 */
export const assertConfigEnvSet = async (cwd: string): Promise<void> => {
  const unset = await findUnsetConfigEnv(cwd);
  if (unset.length === 0) return;
  const them = unset.length === 1 ? "it" : "them";
  throw new Error(
    [
      `hot-updater.config reads ${unset.length === 1 ? "this" : "these"} with process.env, and ${unset.length === 1 ? "it is" : "they are"} not set:`,
      ...unset,
      `Set ${them} in .env.hotupdater, or read ${them} with secretEnv:`,
      SECRETS_DOCS_URL,
    ].join("\n"),
  );
};
