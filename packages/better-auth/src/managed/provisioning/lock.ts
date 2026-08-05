import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

import {
  assertSecureParent,
  FILE_MODE,
  hardenFile,
  hasCode,
  ProvisioningError,
  unlinkIfPresent,
  validateFile,
} from "./files";

const LOCK_RETRY_MS = 10;
const LOCK_WAIT_MS = 1_000;

const delay = (): Promise<void> =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, LOCK_RETRY_MS);
  });

const acquireLock = async (envFilePath: string): Promise<string> => {
  const lockPath = `${envFilePath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(
        lockPath,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW |
          fsConstants.O_RDWR,
        FILE_MODE,
      );
      try {
        const identity = await validateFile(
          handle,
          "Managed API-key provisioning lock",
        );
        await hardenFile(handle, identity, "Managed API-key provisioning lock");
      } catch (error) {
        await handle.close();
        await unlinkIfPresent(lockPath);
        throw error;
      }
      try {
        await handle.close();
      } catch (error) {
        await unlinkIfPresent(lockPath);
        throw error;
      }
      return lockPath;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (Date.now() >= deadline) {
        throw new ProvisioningError(
          `Timed out waiting for managed API-key provisioning lock: ${lockPath}`,
        );
      }
      await delay();
    }
  }
};

export const withExclusiveLock = async <Value>(
  envFilePath: string,
  action: () => Promise<Value>,
): Promise<Value> => {
  await assertSecureParent(envFilePath);
  const lockPath = await acquireLock(envFilePath);
  try {
    await assertSecureParent(envFilePath);
    return await action();
  } finally {
    await unlinkIfPresent(lockPath);
  }
};
