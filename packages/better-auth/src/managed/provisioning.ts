import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { provisionCanonicalEnvironmentFile } from "./provisioning/environmentFile";
import {
  assertPermissionHardeningSupported,
  assertSecureParentDirectory,
  assertTrustedRequestedDirectoryChain,
} from "./provisioning/fileSecurity";
import {
  HOT_UPDATER_API_KEY_ENV_NAME,
  type ProvisionManagedBetterAuthApiKeyOptions,
  type ProvisionedManagedBetterAuthApiKey,
} from "./provisioning/shared";

export {
  HOT_UPDATER_API_KEY_ENV_NAME,
  type ProvisionManagedBetterAuthApiKeyOptions,
  type ProvisionedManagedBetterAuthApiKey,
};

const pendingProvisioning = new Map<
  string,
  Promise<ProvisionedManagedBetterAuthApiKey>
>();

export const provisionManagedBetterAuthApiKey = async (
  options: ProvisionManagedBetterAuthApiKeyOptions = {},
): Promise<ProvisionedManagedBetterAuthApiKey> => {
  assertPermissionHardeningSupported();
  const requestedPath = resolve(options.envFilePath ?? ".env.hotupdater");
  await assertTrustedRequestedDirectoryChain(requestedPath);
  const envFilePath = join(
    await realpath(dirname(requestedPath)),
    basename(requestedPath),
  );
  await assertSecureParentDirectory(envFilePath);

  const existing = pendingProvisioning.get(envFilePath);
  if (existing !== undefined) return existing;

  const provisioning = provisionCanonicalEnvironmentFile(envFilePath);
  pendingProvisioning.set(envFilePath, provisioning);
  try {
    return await provisioning;
  } finally {
    if (pendingProvisioning.get(envFilePath) === provisioning) {
      pendingProvisioning.delete(envFilePath);
    }
  }
};
