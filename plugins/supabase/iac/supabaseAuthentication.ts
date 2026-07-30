import { link, p } from "@hot-updater/cli-tools";
import { execa } from "execa";

import { initProvider as SUPABASE_INIT_PROVIDER } from "./init/index";

const SUPABASE_AUTH_METHOD = {
  accessToken: "access-token",
  cliLogin: "cli-login",
} as const;

type SupabaseAuthMethod =
  (typeof SUPABASE_AUTH_METHOD)[keyof typeof SUPABASE_AUTH_METHOD];

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
    await execa("npx", ["-y", "supabase", "login", "--agent", "no"], {
      stdio: "inherit",
    });
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
