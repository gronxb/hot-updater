import { randomBytes } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";

import {
  assertSecureParentDirectory,
  currentUserId,
  FILE_PERMISSION_MASK,
  type FileIdentity,
  hasIdentity,
  identityFrom,
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  pathHasIdentity,
  secureRegularFile,
  unlinkIfPresent,
} from "./fileSecurity";
import {
  captureOutcome,
  collectFailures,
  combineFailure,
  finishOutcome,
  hasErrorCode,
  ManagedBetterAuthProvisioningError,
} from "./shared";

const LOCK_RETRY_INTERVAL_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_OWNER_PATTERN = /^owner-([1-9]\d*)-([a-f0-9]{32})$/u;

type ProvisioningLock = Readonly<{
  ownerEntryPath: string;
  path: string;
}>;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });

const parseLockOwnerPid = (entryName: string): number | undefined => {
  const match = LOCK_OWNER_PATTERN.exec(entryName);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : undefined;
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
};

const assertSecureLockDirectory = async (
  lockPath: string,
): Promise<FileIdentity> => {
  const stats = await lstat(lockPath, { bigint: true });
  if (
    !stats.isDirectory() ||
    stats.uid !== currentUserId() ||
    (stats.mode & BigInt(FILE_PERMISSION_MASK)) !==
      BigInt(OWNER_ONLY_DIRECTORY_MODE)
  ) {
    throw new ManagedBetterAuthProvisioningError(
      "Managed API-key provisioning lock must be a user-owned directory with mode 0700.",
    );
  }
  return identityFrom(stats);
};

const removeEmptyLockDirectory = async (lockPath: string): Promise<void> => {
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTEMPTY")) {
      return;
    }
    throw error;
  }
};

const inspectProvisioningLock = async (lockPath: string): Promise<boolean> => {
  const directoryIdentity = await assertSecureLockDirectory(lockPath);
  const entries = await readdir(lockPath);
  if (entries.length === 0) {
    await removeEmptyLockDirectory(lockPath);
    return true;
  }
  const ownerPids = entries.map(parseLockOwnerPid);
  if (ownerPids.some((pid) => pid === undefined)) {
    throw new ManagedBetterAuthProvisioningError(
      "Managed API-key provisioning lock contains an invalid owner entry.",
    );
  }
  let hasLiveOwner = false;
  for (const [index, entry] of entries.entries()) {
    const ownerPid = ownerPids[index];
    if (ownerPid === undefined) {
      throw new ManagedBetterAuthProvisioningError(
        "Managed API-key provisioning lock contains an invalid owner entry.",
      );
    }
    const ownerEntryPath = join(lockPath, entry);
    let handle: FileHandle;
    try {
      handle = await open(
        ownerEntryPath,
        fileSystemConstants.O_NOFOLLOW | fileSystemConstants.O_RDONLY,
      );
    } catch (error) {
      if (
        hasErrorCode(error, "ENOENT") ||
        !(await pathHasIdentity(lockPath, directoryIdentity))
      ) {
        continue;
      }
      throw error;
    }
    const outcome = await captureOutcome(async () => {
      const stats = await handle.stat({ bigint: true });
      if (stats.isFile() && stats.nlink === 0n) return false;
      if (
        !stats.isFile() ||
        stats.nlink !== 1n ||
        stats.uid !== currentUserId()
      ) {
        throw new ManagedBetterAuthProvisioningError(
          "Managed API-key provisioning lock owner must be a user-owned regular file with a single hard link.",
        );
      }
      if (
        (stats.mode & BigInt(FILE_PERMISSION_MASK)) !==
        BigInt(OWNER_ONLY_FILE_MODE)
      ) {
        throw new ManagedBetterAuthProvisioningError(
          "Managed API-key provisioning lock owner must have mode 0600.",
        );
      }
      return true;
    });
    const cleanupFailures = await collectFailures([() => handle.close()]);
    const ownerEntryPresent = finishOutcome(
      outcome,
      cleanupFailures,
      "Managed API-key provisioning lock inspection cleanup failed.",
    );
    if (!ownerEntryPresent) continue;
    if (isProcessAlive(ownerPid)) {
      hasLiveOwner = true;
    } else {
      await unlinkIfPresent(ownerEntryPath);
    }
  }
  if (hasLiveOwner) return false;
  await removeEmptyLockDirectory(lockPath);
  return true;
};

const createProvisioningLock = async (
  lockPath: string,
  directoryIdentity: FileIdentity,
): Promise<ProvisioningLock | undefined> => {
  const ownerEntryName = `owner-${process.pid}-${randomBytes(16).toString(
    "hex",
  )}`;
  const ownerEntryPath = join(lockPath, ownerEntryName);
  const handle = await open(
    ownerEntryPath,
    fileSystemConstants.O_CREAT |
      fileSystemConstants.O_EXCL |
      fileSystemConstants.O_NOFOLLOW |
      fileSystemConstants.O_RDWR,
    OWNER_ONLY_FILE_MODE,
  );
  const outcome = await captureOutcome(async () => {
    await secureRegularFile(handle, "Managed API-key provisioning lock owner");
    await handle.sync();
    const [currentDirectory, entries] = await Promise.all([
      lstat(lockPath, { bigint: true }),
      readdir(lockPath),
    ]);
    return (
      hasIdentity(currentDirectory, directoryIdentity) &&
      entries.length === 1 &&
      entries[0] === ownerEntryName
    );
  });
  const closeFailures = await collectFailures([() => handle.close()]);
  if (outcome.ok && outcome.value && closeFailures.length === 0) {
    return Object.freeze({
      ownerEntryPath,
      path: lockPath,
    });
  }

  const cleanupFailures = await collectFailures([
    () => unlinkIfPresent(ownerEntryPath),
    () => removeEmptyLockDirectory(lockPath),
  ]);
  if (!outcome.ok) {
    throw combineFailure(outcome.error, [...closeFailures, ...cleanupFailures]);
  }
  if (closeFailures.length > 0) {
    throw combineFailure(closeFailures[0], [
      ...closeFailures.slice(1),
      ...cleanupFailures,
    ]);
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "Managed API-key provisioning lock race cleanup failed.",
      { cause: cleanupFailures[0] },
    );
  }
  return undefined;
};

const acquireProvisioningLock = async (
  envFilePath: string,
): Promise<ProvisioningLock> => {
  const lockPath = `${envFilePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await mkdir(lockPath, { mode: OWNER_ONLY_DIRECTORY_MODE });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      try {
        if (await inspectProvisioningLock(lockPath)) continue;
      } catch (inspectionError) {
        if (hasErrorCode(inspectionError, "ENOENT")) continue;
        throw inspectionError;
      }
      if (Date.now() >= deadline) {
        throw new ManagedBetterAuthProvisioningError(
          `Timed out waiting for managed API-key provisioning lock: ${lockPath}`,
        );
      }
      await delay(LOCK_RETRY_INTERVAL_MS);
      continue;
    }

    let directoryIdentity: FileIdentity;
    try {
      directoryIdentity = await assertSecureLockDirectory(lockPath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    try {
      const lock = await createProvisioningLock(lockPath, directoryIdentity);
      if (lock !== undefined) return lock;
    } catch (error) {
      if (
        hasErrorCode(error, "ENOENT") ||
        !(await pathHasIdentity(lockPath, directoryIdentity))
      ) {
        continue;
      }
      throw error;
    }
  }
};

const releaseProvisioningLock = async (
  lock: ProvisioningLock,
): Promise<readonly unknown[]> =>
  collectFailures([
    () => unlinkIfPresent(lock.ownerEntryPath),
    () => removeEmptyLockDirectory(lock.path),
  ]);

export const withProvisioningLock = async <Value>(
  envFilePath: string,
  operation: () => Promise<Value>,
): Promise<Value> => {
  await assertSecureParentDirectory(envFilePath);
  const lock = await acquireProvisioningLock(envFilePath);
  const directoryOutcome = await captureOutcome(() =>
    assertSecureParentDirectory(envFilePath),
  );
  if (!directoryOutcome.ok) {
    const cleanupFailures = await releaseProvisioningLock(lock);
    throw combineFailure(directoryOutcome.error, cleanupFailures);
  }
  const outcome = await captureOutcome(operation);
  const cleanupFailures = await releaseProvisioningLock(lock);
  return finishOutcome(
    outcome,
    cleanupFailures,
    "Managed API-key provisioning lock cleanup failed.",
  );
};
