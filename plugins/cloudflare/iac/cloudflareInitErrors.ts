import { InitError } from "@hot-updater/cli-tools";
import { APIError } from "cloudflare/error";

export const CLOUDFLARE_INIT_PERMISSION = {
  d1: "D1: Edit",
} as const;

export const CLOUDFLARE_INIT_PERMISSIONS = [
  CLOUDFLARE_INIT_PERMISSION.d1,
] as const;

export type CloudflareCredentialSource =
  | {
      readonly kind: "environment";
    }
  | {
      readonly envFile: string;
      readonly kind: "env-file";
    }
  | {
      readonly kind: "prompt";
    }
  | {
      readonly kind: "wrangler-oauth";
    };

const getCredentialRemediation = (
  source: CloudflareCredentialSource,
): readonly string[] => {
  switch (source.kind) {
    case "environment":
      return [
        "Update HOT_UPDATER_CLOUDFLARE_API_TOKEN in the environment, then rerun init.",
      ];
    case "env-file":
      return [
        `Update HOT_UPDATER_CLOUDFLARE_API_TOKEN in ${source.envFile}, then rerun init.`,
        "Alternatively, rerun without --init-env-file to enter a new token.",
      ];
    case "prompt":
      return ["Create a new API token, then rerun init and enter it again."];
    case "wrangler-oauth":
      return [
        "Refresh Wrangler authentication with `npx wrangler login`, then rerun init.",
      ];
  }
};

const getErrorOutput = (error: unknown): string => {
  const output: string[] = [];
  if (error instanceof Error) {
    output.push(error.message);
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string"
  ) {
    output.push(error.stderr);
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "stdout" in error &&
    typeof error.stdout === "string"
  ) {
    output.push(error.stdout);
  }
  return output.join("\n");
};

export const isCloudflareAuthenticationError = (error: unknown): boolean => {
  if (error instanceof APIError) {
    return (
      error.status === 401 ||
      error.status === 403 ||
      error.errors.some(
        ({ code }) =>
          code === 6003 || code === 6111 || code === 10000 || code === 9109,
      ) ||
      /invalid format for authorization header/i.test(error.message)
    );
  }

  return [
    /authentication error/i,
    /invalid access token/i,
    /invalid format for authorization header/i,
    /code:\s*(?:6003|6111|10000|9109)/i,
    /"code"\s*:\s*(?:6003|6111|10000|9109)/i,
  ].some((pattern) => pattern.test(getErrorOutput(error)));
};

export class CloudflareAuthenticationError extends InitError {
  readonly name = "CloudflareAuthenticationError";

  constructor(
    readonly source: CloudflareCredentialSource,
    readonly accountId?: string,
    options?: ErrorOptions,
  ) {
    super(
      [
        source.kind === "wrangler-oauth"
          ? "Cloudflare Wrangler authentication failed."
          : "Cloudflare API token is invalid, expired, or missing required permissions.",
        ...(accountId
          ? [
              `Selected account: ${accountId}`,
              "Confirm the token is active and its resource scope includes this account.",
            ]
          : []),
        ...getCredentialRemediation(source),
        ...(source.kind === "wrangler-oauth"
          ? []
          : [
              `Required permissions: ${CLOUDFLARE_INIT_PERMISSIONS.join(", ")}`,
            ]),
        "Verify token status: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/#test-the-token",
      ].join("\n"),
      options,
    );
  }
}

export class CloudflarePermissionError extends InitError {
  readonly name = "CloudflarePermissionError";

  constructor(
    readonly source: CloudflareCredentialSource,
    {
      accountId,
      check,
      requiredPermission,
    }: {
      readonly accountId: string;
      readonly check: string;
      readonly requiredPermission: string;
    },
    options?: ErrorOptions,
  ) {
    super(
      [
        "Cloudflare API token cannot access a required account resource.",
        `Selected account: ${accountId}`,
        `Failed check: ${check}`,
        `Required permission: ${requiredPermission}`,
        "Confirm the token permission and account resource scope, then rerun init.",
        ...getCredentialRemediation(source),
      ].join("\n"),
      options,
    );
    this.accountId = accountId;
    this.check = check;
    this.requiredPermission = requiredPermission;
  }

  readonly accountId: string;
  readonly check: string;
  readonly requiredPermission: string;
}

export class CloudflareDeploymentError extends InitError {
  readonly name = "CloudflareDeploymentError";

  constructor(cause: Error) {
    super(
      [
        "Cloudflare Worker deployment failed.",
        "Review the Wrangler error above, fix the reported resource or permission, then rerun init.",
        `Cause: ${cause.message}`,
      ].join("\n"),
      { cause },
    );
  }
}

export class CloudflareApiRequestError extends InitError {
  readonly name = "CloudflareApiRequestError";

  constructor(cause: APIError) {
    super(
      [
        "Cloudflare infrastructure request failed.",
        "Review the Cloudflare error, confirm the token permissions and selected resources, then rerun init.",
        `Cause: ${cause.message}`,
      ].join("\n"),
      { cause },
    );
  }
}

export const toCloudflareApiError = (
  error: unknown,
  source: CloudflareCredentialSource,
): Error => {
  if (error instanceof InitError) {
    return error;
  }
  if (isCloudflareAuthenticationError(error)) {
    return new CloudflareAuthenticationError(source, undefined, {
      cause: error,
    });
  }
  if (error instanceof APIError) {
    return new CloudflareApiRequestError(error);
  }
  return error instanceof Error ? error : new Error(String(error));
};

export const runCloudflareApiRequest = async <Result>({
  request,
  source,
}: {
  readonly request: () => Promise<Result>;
  readonly source: CloudflareCredentialSource;
}): Promise<Result> => {
  try {
    return await request();
  } catch (error) {
    if (error instanceof Error) {
      throw toCloudflareApiError(error, source);
    }
    throw new Error(String(error));
  }
};

export const toCloudflareDeploymentError = (
  error: unknown,
  source: CloudflareCredentialSource,
): InitError => {
  const apiError = toCloudflareApiError(error, source);
  return apiError instanceof InitError
    ? apiError
    : new CloudflareDeploymentError(apiError);
};
