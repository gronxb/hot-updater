import { execa } from "execa";

export const createWrangler = ({
  stdio,
  cloudflareApiToken,
  cwd,
}: {
  stdio?: "inherit" | "pipe" | "ignore" | "overlapped";
  cloudflareApiToken: string;
  cwd: string;
}) => {
  const $ = execa({
    stdio,
    extendsEnv: true,
    cwd,
    env: {
      CLOUDFLARE_API_TOKEN: cloudflareApiToken,
    },
  });

  return (...command: string[]) => $("npx", ["wrangler", ...command]);
};
