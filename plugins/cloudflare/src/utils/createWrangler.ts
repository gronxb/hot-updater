import { execa } from "execa";

export const createWrangler = ({
  stdio,
  accountId,
  cloudflareApiToken,
  cwd,
  nonInteractive,
}: {
  stdio?: "inherit" | "pipe" | "ignore" | "overlapped";
  accountId: string;
  cloudflareApiToken: string;
  cwd: string;
  nonInteractive?: boolean;
}) => {
  const $ = execa({
    stdio,
    extendsEnv: true,
    shell: stdio === "inherit",
    cwd,
    env: {
      ...(nonInteractive ? { CI: "true" } : {}),
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: cloudflareApiToken,
    },
  });

  return (...command: string[]) => $("npx", ["wrangler", ...command]);
};
