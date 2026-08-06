import { InitError } from "@hot-updater/cli-tools";
import dayjs from "dayjs";
import { execa } from "execa";

import { getWranglerLoginAuthToken } from "./getWranglerLoginAuthToken";

export class CloudflareWranglerLoginRequiredError extends InitError {
  readonly name = "CloudflareWranglerLoginRequiredError";

  constructor() {
    super(
      [
        "Cloudflare Wrangler login is required.",
        "Run `npx wrangler login` interactively, then rerun init.",
      ].join("\n"),
    );
  }
}

const getValidWranglerAuthToken = () => {
  const auth = getWranglerLoginAuthToken();
  if (!auth || dayjs(auth.expiration_time).isBefore(dayjs())) {
    return undefined;
  }
  return auth.oauth_token;
};

export const resolveCloudflareInfrastructureApiToken = async ({
  cwd,
  nonInteractive,
}: {
  readonly cwd: string;
  readonly nonInteractive: boolean;
}): Promise<string> => {
  const existingToken = getValidWranglerAuthToken();
  if (existingToken) {
    return existingToken;
  }
  if (nonInteractive) {
    throw new CloudflareWranglerLoginRequiredError();
  }

  await execa(
    "npx",
    [
      "wrangler",
      "login",
      "--scopes",
      "account:read",
      "user:read",
      "d1:write",
      "workers:write",
      "workers_scripts:write",
    ],
    { cwd },
  );

  const authenticatedToken = getValidWranglerAuthToken();
  if (!authenticatedToken) {
    throw new CloudflareWranglerLoginRequiredError();
  }
  return authenticatedToken;
};
