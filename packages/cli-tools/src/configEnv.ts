import fs from "node:fs/promises";
import path from "node:path";

/** The names hot-updater.config may have, as `loadConfig` looks them up. */
const CONFIG_FILES = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
  (extension) => `hot-updater.config.${extension}`,
);

/**
 * `process.env.NAME!` and `process.env["NAME"]!`: a read the config asserts
 * is set. Not `!=`, and not one with a fallback after it, `?? …` or `|| …`.
 */
const ASSERTED_READ =
  /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])\s*!(?!=)(?!\s*(?:\?\?|\|\|))/gu;

/** Block and line comments, whose code never runs. */
const COMMENTS = /\/\*[\s\S]*?\*\/|(?<![:"'`\\])\/\/[^\n]*/gu;

/** Where `process.env` reads are documented against `secretEnv`. */
const SECRETS_DOCS_URL = "https://hot-updater.dev/docs/concepts/secrets";

const UNSET_ENV_READS = Symbol.for("@hot-updater/cli-tools/unset-env-reads");

/**
 * Runs `evaluate`, a config's evaluation, adding to `reads` each variable
 * it reads from `process.env` while that variable is unset or empty. Only
 * reads are watched: what the evaluation sets goes to `process.env` as it
 * is, and `process.env` is itself again afterwards.
 */
export const trackUnsetEnvReads = async <T>(
  reads: Set<string>,
  evaluate: () => Promise<T>,
): Promise<T> => {
  const env = process.env;
  process.env = new Proxy(env, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key);
      if (typeof key === "string" && (value === undefined || value === "")) {
        reads.add(key);
      }
      return value;
    },
  });
  try {
    return await evaluate();
  } finally {
    process.env = env;
  }
};

/** Keeps the unset variables a config's evaluation read on the config. */
export const recordUnsetEnvReads = (
  config: object,
  reads: ReadonlySet<string>,
): void => {
  Object.defineProperty(config, UNSET_ENV_READS, { value: [...reads] });
};

const unsetEnvReadsOf = (config: object): readonly string[] => {
  const reads: unknown = Reflect.get(config, UNSET_ENV_READS);
  return Array.isArray(reads) ? reads : [];
};

/** The variables `cwd`'s hot-updater.config asserts with `process.env.<name>!`. */
const readAssertedEnv = async (cwd: string): Promise<ReadonlySet<string>> => {
  for (const file of CONFIG_FILES) {
    const text = await fs
      .readFile(path.join(cwd, file), "utf-8")
      .catch(() => undefined);
    if (text === undefined) continue;
    return new Set(
      [...text.replace(COMMENTS, "").matchAll(ASSERTED_READ)].map(
        (match) => match[1] ?? match[2]!,
      ),
    );
  }
  return new Set();
};

/**
 * The variables `config`, loaded from `cwd`, needs and the environment
 * lacks: each one its evaluation read while it was unset
 * (`trackUnsetEnvReads`), that its source asserts with
 * `process.env.<name>!`, and that is still unset. An adapter would hand
 * `undefined` for it to its provider's SDK, whose error names no variable.
 * A read in a comment, a branch that didn't run, or one with a fallback is
 * none.
 */
export const findUnsetConfigEnv = async (
  config: object,
  cwd: string,
): Promise<readonly string[]> => {
  const reads = unsetEnvReadsOf(config);
  if (reads.length === 0) return [];
  const asserted = await readAssertedEnv(cwd);
  return reads.filter(
    (name) => asserted.has(name) && !process.env[name]?.trim(),
  );
};

/**
 * Refuses, before any adapter reaches its provider, a config that needs
 * variables the environment doesn't set (`findUnsetConfigEnv`), naming each
 * and how to set it.
 */
export const assertConfigEnvSet = async (
  config: object,
  cwd: string,
): Promise<void> => {
  const unset = await findUnsetConfigEnv(config, cwd);
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
