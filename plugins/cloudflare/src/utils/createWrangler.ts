import { execa } from "execa";

export const createWrangler = ({
  cloudflareApiToken,
  cwd,
}: { cloudflareApiToken: string; cwd: string }) => {
  const $ = execa({
    extendsEnv: true,
    cwd,
    env: {
      CLOUDFLARE_API_TOKEN: cloudflareApiToken,
    },
  });

  return (...command: string[]) => $("npx", ["wrangler", ...command]);
};
