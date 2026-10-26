import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Relocates Hot Updater's per-user directory, `~/.hot-updater` by default,
 * such as for CI caches or tests.
 */
export const HOT_UPDATER_HOME_ENV = "HOT_UPDATER_HOME";

/** Hot Updater's per-user directory: `$HOT_UPDATER_HOME`, else `~/.hot-updater`. */
export const getHotUpdaterHome = (): string => {
  const home = process.env[HOT_UPDATER_HOME_ENV]?.trim();
  return home ? path.resolve(home) : path.join(os.homedir(), ".hot-updater");
};

const git = (cwd: string, args: readonly string[]): string | undefined => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
  }
};

const realpath = (directory: string) => {
  try {
    return realpathSync(directory);
  } catch {
    return path.resolve(directory);
  }
};

/**
 * The project's directory name in the store: the project directory's name
 * and the first 12 hex digits of the SHA-256 of its real path, such as
 * `my-app-3f2a9c1d04be`. Each checkout of an app has its own.
 */
export const getProjectKey = (cwd: string): string => {
  const directory = realpath(cwd);
  const label =
    path
      .basename(directory)
      .replace(/[^A-Za-z0-9._-]/gu, "-")
      .replace(/^[.-]+/u, "")
      .slice(0, 40) || "project";
  const hash = createHash("sha256")
    .update(directory)
    .digest("hex")
    .slice(0, 12);
  return `${label}-${hash}`;
};

/**
 * The directory `local()` keeps a project's secrets in without a
 * `path`: `<home>/secrets/<project-key>` (`getHotUpdaterHome`,
 * `getProjectKey`).
 */
export const getLocalKeyStoreDir = (cwd: string): string =>
  path.join(getHotUpdaterHome(), "secrets", getProjectKey(cwd));

/**
 * `local({ path })`'s directory: `~` is the home directory, and a
 * relative path is the project's (`cwd`).
 */
export const resolveLocalSecretsPath = (value: string, cwd: string): string => {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(cwd, value);
};

const isMissing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** `target`'s real path, through its nearest parent that exists. */
const realpathThroughParents = (target: string): string => {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
};

/** Whether git ignores `directory`, a path in the work tree at `root`. */
const isIgnoredByGit = (root: string, directory: string) => {
  const relative = path.relative(root, directory).split(path.sep).join("/");
  const result = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--", `${relative}/`],
    { cwd: root, stdio: "ignore", timeout: 10_000 },
  );
  return result.status === 0;
};

/**
 * Refuses a directory secrets must not go in: a path that exists and is no
 * directory, or one in a git work tree that git does not ignore, whose
 * secrets could be committed.
 */
const assertPrivateDirectory = async (directory: string) => {
  const stats = await fs.stat(directory).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (stats && !stats.isDirectory()) {
    throw new Error(
      `local() keeps secrets in a directory, and ${directory} is not one. Set its path to a directory.`,
    );
  }
  const real = realpathThroughParents(directory);
  let probe = real;
  while (!existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe);
  }
  const root = git(probe, ["rev-parse", "--show-toplevel"]);
  if (!root) return;
  const top = realpath(root);
  if (isIgnoredByGit(top, real)) return;
  throw new Error(
    `local() refuses ${directory}: it is in the git repository ${top}, which does not ignore it, so the secrets in it could be committed. Add ${path.relative(top, real).split(path.sep).join("/")}/ to .gitignore, or set its path outside the repository, such as ~/.hot-updater/secrets/<app>.`,
  );
};

/** Makes `directory` 0700, and every directory it creates on the way. */
const makePrivateDirectory = async (directory: string) => {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode as it is. Windows has no
  // mode bits: the user profile's permissions apply there.
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
};

/** Where `local()` keeps a project's secrets, one file per name. */
export interface LocalSecretsStore {
  /** The project's directory. */
  readonly directory: (cwd: string) => string;
  /**
   * The file `name` is kept in, `<name>.json`. A secret's name has no path
   * separator and does not start with a dot.
   */
  readonly file: (name: string, cwd: string) => string;
  /** `name`'s value, or undefined. */
  readonly read: (name: string, cwd: string) => Promise<string | undefined>;
  /**
   * Stores `value` as `name`: the directory is 0700 and the file 0600,
   * readable by this user alone, and a write replaces the file whole or
   * not at all. Returns the file.
   */
  readonly write: (name: string, value: string, cwd: string) => Promise<string>;
}

/**
 * The store `local({ path })` reads and writes: `path`, or
 * `getLocalKeyStoreDir` without one. Its first use refuses a directory
 * secrets must not go in (`assertPrivateDirectory`).
 */
export const createLocalSecretsStore = ({
  path: configured,
}: { readonly path?: string } = {}): LocalSecretsStore => {
  const checked = new Map<string, Promise<void>>();
  const directory = (cwd: string) =>
    configured === undefined
      ? getLocalKeyStoreDir(cwd)
      : resolveLocalSecretsPath(configured, cwd);
  const check = (target: string) => {
    let pending = checked.get(target);
    if (!pending) {
      pending = assertPrivateDirectory(target);
      checked.set(target, pending);
      pending.catch(() => checked.delete(target));
    }
    return pending;
  };
  const file = (name: string, cwd: string) =>
    path.join(directory(cwd), `${name}.json`);
  return {
    directory,
    file,
    read: async (name, cwd) => {
      await check(directory(cwd));
      try {
        return (await fs.readFile(file(name, cwd), "utf-8")) || undefined;
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    write: async (name, value, cwd) => {
      const target = directory(cwd);
      await check(target);
      await makePrivateDirectory(target);
      const destination = file(name, cwd);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, value, { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, destination);
      } catch (error) {
        await fs.rm(temporary, { force: true });
        throw error;
      }
      return destination;
    },
  };
};

const defaultStore = createLocalSecretsStore();

/** The file `local()` without a `path` keeps `name` in. */
export const getLocalKeyFile = (name: string, cwd: string): string =>
  defaultStore.file(name, cwd);

/** `name`'s value in `local()`'s default store, or undefined. */
export const readLocalKey = (
  name: string,
  cwd: string,
): Promise<string | undefined> => defaultStore.read(name, cwd);

/** Stores `value` as `name` in `local()`'s default store. */
export const writeLocalKey = (
  name: string,
  value: string,
  cwd: string,
): Promise<string> => defaultStore.write(name, value, cwd);
