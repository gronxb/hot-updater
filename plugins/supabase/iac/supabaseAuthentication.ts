import { link, p } from "@hot-updater/cli-tools";
import { execa } from "execa";

import { initProvider as SUPABASE_INIT_PROVIDER } from "./init/index";

const SUPABASE_AUTH_METHOD = {
  accessToken: "access-token",
  cliLogin: "cli-login",
} as const;

type SupabaseAuthMethod =
  (typeof SUPABASE_AUTH_METHOD)[keyof typeof SUPABASE_AUTH_METHOD];

const SUPABASE_LOGIN_URL_PATTERN =
  /https:\/\/supabase\.com\/dashboard\/cli\/login\?[A-Za-z0-9._~!$&'()*+,;=:@/?%-]+/;

const openBrowser = async (url: string): Promise<void> => {
  if (process.platform === "darwin") {
    await execa("open", [url]);
    return;
  }
  if (process.platform === "win32") {
    await execa("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
    return;
  }
  await execa("xdg-open", [url]);
};

const hasValidSupabaseCliLogin = async (): Promise<boolean> => {
  const result = await execa(
    "npx",
    ["-y", "supabase", "projects", "list", "--output", "json", "--agent", "no"],
    { reject: false },
  );
  return result.exitCode === 0;
};

export const getSupabaseCliEnv = (
  accessToken?: string,
): Readonly<Record<string, string>> | undefined =>
  accessToken
    ? {
        [SUPABASE_INIT_PROVIDER.inputs.accessToken.envKey]: accessToken,
      }
    : undefined;

export const inputSupabaseAccessToken = async (
  accessToken?: string,
): Promise<string | undefined> => {
  if (accessToken) {
    return accessToken;
  }

  const authMethod = await p.select<SupabaseAuthMethod>({
    message: "How do you want to authenticate with Supabase?",
    options: [
      {
        label: "Use Supabase CLI login",
        value: SUPABASE_AUTH_METHOD.cliLogin,
      },
      {
        label: "Enter a personal access token",
        value: SUPABASE_AUTH_METHOD.accessToken,
      },
    ],
  });
  if (p.isCancel(authMethod)) {
    process.exit(0);
  }

  if (authMethod === SUPABASE_AUTH_METHOD.cliLogin) {
    if (await hasValidSupabaseCliLogin()) {
      return undefined;
    }
    const loginProcess = execa(
      "npx",
      ["-y", "supabase", "login", "--no-browser", "--agent", "no"],
      {
        stdin: "inherit",
        stderr: "inherit",
        stdout: "pipe",
      },
    );
    let output = "";
    let browserOpenPromise: Promise<void> | undefined;
    loginProcess.stdout?.on("data", (chunk: Buffer | string) => {
      process.stdout.write(chunk);
      output += chunk.toString();
      const loginUrl = output.match(SUPABASE_LOGIN_URL_PATTERN)?.[0];
      if (loginUrl && !browserOpenPromise) {
        browserOpenPromise = openBrowser(loginUrl).catch(() => {
          p.log.warn("Could not open the Supabase login page automatically.");
        });
      }
    });
    await loginProcess;
    await browserOpenPromise;
    return undefined;
  }

  p.log.step(
    `Personal access token: ${link(
      "https://supabase.com/dashboard/account/tokens",
    )}`,
  );
  const selectedAccessToken = await p.password({
    message: "Enter your Supabase personal access token",
    validate: (value) =>
      value ? undefined : "Supabase access token is required",
  });
  if (p.isCancel(selectedAccessToken)) {
    process.exit(0);
  }
  return selectedAccessToken;
};
