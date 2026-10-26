import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
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

/**
 * A remote's URL without its scheme, credentials, `.git`, or trailing
 * slash, so the HTTPS and SSH URLs of one repository are the same:
 * `github.com/owner/repo`.
 */
export const normalizeRemoteUrl = (url: string): string => {
  const trimmed = url.trim().replace(/\/+$/u, "").replace(/\.git$/u, "");
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/u.exec(trimmed);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    return `${scp[1]!.toLowerCase()}/${scp[2]}`;
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
  } catch {
    return trimmed;
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
 * What identifies the project: its git repository's `origin` remote and
 * its directory in the repository, so every clone of one app on a machine
 * shares its keys, and two apps of one repository do not; without an
 * `origin`, the project's directory.
 */
export const getProjectIdentity = (cwd: string): string => {
  const directory = realpath(cwd);
  const origin = git(directory, ["remote", "get-url", "origin"]);
  const root = origin
    ? git(directory, ["rev-parse", "--show-toplevel"])
    : undefined;
  if (!origin || !root) return `path:${directory}`;
  const relative = path
    .relative(realpath(root), directory)
    .split(path.sep)
    .join("/");
  return `git:${normalizeRemoteUrl(origin)}#${relative}`;
};

const projectKeys = new Map<string, string>();

/**
 * The project's directory name in the key store: the repository's, or the
 * project directory's, name with a hash of its identity
 * (`getProjectIdentity`), such as `my-app-3f2a9c1d04be`.
 */
export const getProjectKey = (cwd: string): string => {
  const cached = projectKeys.get(cwd);
  if (cached) return cached;
  const identity = getProjectIdentity(cwd);
  const named = identity.startsWith("git:")
    ? identity.slice(4).split("#")[0]!
    : identity.slice(5);
  const label =
    path.posix
      .basename(named.split(path.sep).join("/"))
      .replace(/[^A-Za-z0-9._-]/gu, "-")
      .replace(/^[.-]+/u, "")
      .slice(0, 40) || "project";
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const key = `${label}-${hash}`;
  projectKeys.set(cwd, key);
  return key;
};

/** The project's directory in the key store, `<home>/keys/<project-key>`. */
export const getLocalKeyStoreDir = (cwd: string): string =>
  path.join(getHotUpdaterHome(), "keys", getProjectKey(cwd));

/**
 * The file the key store keeps `name` in, `<name>.json`. A secret's name
 * has no path separator and does not start with a dot.
 */
export const getLocalKeyFile = (name: string, cwd: string): string =>
  path.join(getLocalKeyStoreDir(cwd), `${name}.json`);

const isMissing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** `name`'s value in the project's key store, or undefined. */
export const readLocalKey = async (
  name: string,
  cwd: string,
): Promise<string | undefined> => {
  try {
    return (await fs.readFile(getLocalKeyFile(name, cwd), "utf-8")) || undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/** Makes `directory`, and makes it and its parents up to `home` 0700. */
const makePrivateDirectory = async (directory: string, home: string) => {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode as it is. Windows has no
  // mode bits: the user profile's permissions apply there.
  if (process.platform === "win32") return;
  for (
    let current = directory;
    current.startsWith(home);
    current = path.dirname(current)
  ) {
    await fs.chmod(current, 0o700);
    if (current === home) break;
  }
};

/**
 * Stores `value` as `name` in the project's key store: the directories
 * are 0700 and the file 0600, readable by this user alone, and a write
 * replaces the file whole or not at all. Returns the file.
 */
export const writeLocalKey = async (
  name: string,
  value: string,
  cwd: string,
): Promise<string> => {
  const file = getLocalKeyFile(name, cwd);
  await makePrivateDirectory(path.dirname(file), getHotUpdaterHome());
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return file;
};
