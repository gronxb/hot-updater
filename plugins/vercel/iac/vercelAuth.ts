import fs from "fs";
import os from "os";
import path from "path";

import { InitError } from "@hot-updater/cli-tools";
import { execa } from "execa";

export class VercelLoginRequiredError extends InitError {
  readonly name = "VercelLoginRequiredError";

  constructor() {
    super(
      [
        "A Vercel login is required.",
        "Run `npx vercel login`, or set VERCEL_TOKEN to an access token from https://vercel.com/account/settings/tokens, then rerun init.",
      ].join("\n"),
    );
  }
}

const isDirectory = (target: string) => {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The data directories xdg-app-paths 5, which the Vercel CLI uses, gives an
 * app `name`: the platform's data directory joined with the full name, then
 * `XDG_DATA_DIRS`.
 */
const dataDirs = (name: string) => {
  const { env } = process;
  const home = os.homedir() || os.tmpdir();
  const primary = env.XDG_DATA_HOME
    ? path.join(env.XDG_DATA_HOME, name)
    : process.platform === "win32"
      ? path.join(
          env.APPDATA || path.join(home, "AppData", "Roaming"),
          name,
          "Data",
        )
      : process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", name)
        : path.join(home, ".local", "share", name);
  return [
    primary,
    ...(env.XDG_DATA_DIRS ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, name)),
  ];
};

/** The Vercel CLI's global config directory, found the way the CLI finds it. */
export const getVercelGlobalConfigPath = () => {
  const candidates = [
    ...dataDirs("com.vercel.cli"),
    path.join(os.homedir(), ".now"),
    ...dataDirs("now"),
  ];
  return (
    candidates.find((candidate) => isDirectory(candidate)) ??
    dataDirs("com.vercel.cli")[0]
  );
};

/**
 * The access token of the Vercel CLI's login, while it is valid for another
 * minute. A login the CLI keeps in the system keyring has no token here.
 */
export const readVercelCliToken = (
  configPath = getVercelGlobalConfigPath(),
  now = Date.now(),
): string | undefined => {
  if (configPath === undefined) return undefined;
  try {
    const auth: unknown = JSON.parse(
      fs.readFileSync(path.join(configPath, "auth.json"), "utf8"),
    );
    if (typeof auth !== "object" || auth === null) return undefined;
    const token = Reflect.get(auth, "token");
    const expiresAt = Reflect.get(auth, "expiresAt");
    if (typeof token !== "string" || token.length === 0) return undefined;
    if (typeof expiresAt === "number" && expiresAt * 1000 < now + 60_000) {
      return undefined;
    }
    return token;
  } catch {
    return undefined;
  }
};

/**
 * The token init calls the Vercel API with: `VERCEL_TOKEN`, or the Vercel
 * CLI's login. `vercel whoami` refreshes an expired login; an interactive
 * init without one runs `vercel login`.
 */
export const resolveVercelToken = async ({
  cwd,
  nonInteractive,
  token,
  readToken = readVercelCliToken,
}: {
  readonly cwd: string;
  readonly nonInteractive: boolean;
  readonly token?: string;
  readonly readToken?: () => string | undefined;
}): Promise<string> => {
  if (token) return token;
  const existing = readToken();
  if (existing) return existing;

  await execa("npx", ["vercel", "whoami"], {
    cwd,
    reject: false,
    stdio: "pipe",
  });
  const refreshed = readToken();
  if (refreshed) return refreshed;
  if (nonInteractive) throw new VercelLoginRequiredError();

  await execa("npx", ["vercel", "login"], { cwd, stdio: "inherit" });
  const loggedIn = readToken();
  if (!loggedIn) throw new VercelLoginRequiredError();
  return loggedIn;
};
