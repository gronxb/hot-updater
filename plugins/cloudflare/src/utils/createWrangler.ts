import { execa } from "execa";

export const createWrangler = ({
  stdio,
  accountId,
  cloudflareApiToken,
  cwd,
}: {
  stdio?: "inherit" | "pipe" | "ignore" | "overlapped";
  accountId: string;
  cloudflareApiToken: string;
  cwd: string;
}) => {
  const $ = execa({
    stdio,
    extendsEnv: true,
    cwd,
    env: {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: cloudflareApiToken,
    },
  });

  return (...command: string[]) => $("npx", ["wrangler", ...command]);
};
