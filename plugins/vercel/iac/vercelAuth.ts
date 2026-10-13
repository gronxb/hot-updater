import { InitError } from "@hot-updater/cli-tools";
import { readCredentials } from "@vercel/cli-auth/credentials-store.js";
import { getGlobalPathConfig } from "@vercel/cli-config";
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

/**
 * The access token of the Vercel CLI's login, while it is valid for another
 * minute, read the way the CLI reads it: from `auth.json` in its global config
 * directory, or from the system keyring when the CLI keeps it there.
 */
export const readVercelCliToken = (
  configPath = getGlobalPathConfig(),
  now = Date.now(),
): string | undefined => {
  try {
    const { token, expiresAt } = readCredentials(configPath);
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
