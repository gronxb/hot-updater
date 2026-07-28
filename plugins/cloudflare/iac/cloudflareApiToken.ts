import {
  CloudflareAuthenticationError,
  type CloudflareCredentialSource,
  CloudflarePermissionError,
  isCloudflareAuthenticationError,
  toCloudflareApiError,
} from "./cloudflareInitErrors";

type CloudflareTokenVerification = {
  readonly status?: string;
};

type VerifyCloudflareApiTokenIdentityOptions = {
  readonly accountId: string;
  readonly apiToken: string;
  readonly verifyAccountToken: (
    accountId: string,
  ) => Promise<CloudflareTokenVerification>;
  readonly verifyUserToken: () => Promise<CloudflareTokenVerification>;
};

export type CloudflarePermissionProbe = {
  readonly check: string;
  readonly request: () => Promise<unknown>;
  readonly requiredPermission: string;
};

export const verifyCloudflareApiTokenIdentity = async ({
  accountId,
  apiToken,
  verifyAccountToken,
  verifyUserToken,
}: VerifyCloudflareApiTokenIdentityOptions): Promise<CloudflareTokenVerification> => {
  if (apiToken.startsWith("cfat_")) {
    return verifyAccountToken(accountId);
  }
  if (apiToken.startsWith("cfut_")) {
    return verifyUserToken();
  }

  try {
    return await verifyAccountToken(accountId);
  } catch (error) {
    if (!isCloudflareAuthenticationError(error)) {
      throw error;
    }
    return verifyUserToken();
  }
};

export const validateCloudflareApiToken = async ({
  accountId,
  probes,
  source,
  verify,
}: {
  readonly accountId: string;
  readonly probes: readonly CloudflarePermissionProbe[];
  readonly source: CloudflareCredentialSource;
  readonly verify: () => Promise<CloudflareTokenVerification>;
}): Promise<void> => {
  let verification: CloudflareTokenVerification;
  try {
    verification = await verify();
  } catch (error) {
    if (isCloudflareAuthenticationError(error)) {
      throw new CloudflareAuthenticationError(source, accountId, {
        cause: error,
      });
    }
    throw toCloudflareApiError(error, source);
  }

  if (verification.status !== "active") {
    throw new CloudflareAuthenticationError(source, accountId);
  }

  for (const probe of probes) {
    try {
      await probe.request();
    } catch (error) {
      if (isCloudflareAuthenticationError(error)) {
        throw new CloudflarePermissionError(
          source,
          {
            accountId,
            check: probe.check,
            requiredPermission: probe.requiredPermission,
          },
          { cause: error },
        );
      }
      throw toCloudflareApiError(error, source);
    }
  }
};
