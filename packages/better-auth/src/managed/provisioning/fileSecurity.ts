import { randomBytes } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import { type FileHandle, lstat, open, unlink } from "node:fs/promises";
import { dirname, join, parse, sep } from "node:path";

import {
  collectFailures,
  combineFailure,
  hasErrorCode,
  ManagedBetterAuthProvisioningError,
} from "./shared";

export const OWNER_ONLY_FILE_MODE = 0o600;
export const OWNER_ONLY_DIRECTORY_MODE = 0o700;
export const FILE_PERMISSION_MASK = 0o777;
const GROUP_OR_OTHER_WRITE_MASK = 0o022;
const STICKY_DIRECTORY_MODE = 0o1000;

export type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
}>;

export type OpenEnvironmentFile = Readonly<{
  created: boolean;
  handle: FileHandle;
  identity: FileIdentity;
}>;

export type ReplacementEnvironmentFile = Readonly<{
  handle: FileHandle;
  path: string;
}>;

export const assertPermissionHardeningSupported = (): void => {
  if (
    process.platform === "win32" ||
    process.geteuid === undefined ||
    typeof fileSystemConstants.O_NOFOLLOW !== "number"
  ) {
    throw new ManagedBetterAuthProvisioningError(
      "Managed API-key provisioning requires owner-only file permissions, which are not supported on Windows.",
    );
  }
};

export const identityFrom = (stats: {
  readonly dev: bigint;
  readonly ino: bigint;
}): FileIdentity => Object.freeze({ dev: stats.dev, ino: stats.ino });

export const hasIdentity = (
  stats: { readonly dev: bigint; readonly ino: bigint },
  identity: FileIdentity,
): boolean => stats.dev === identity.dev && stats.ino === identity.ino;

export const pathHasIdentity = async (
  filePath: string,
  identity: FileIdentity,
): Promise<boolean> => {
  try {
    return hasIdentity(await lstat(filePath, { bigint: true }), identity);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
};

export const currentUserId = (): bigint => {
  const getEffectiveUserId = process.geteuid;
  if (getEffectiveUserId === undefined) {
    throw new ManagedBetterAuthProvisioningError(
      "Managed API-key provisioning requires POSIX user ownership metadata.",
    );
  }
  return BigInt(getEffectiveUserId());
};

export const assertTrustedRequestedDirectoryChain = async (
  filePath: string,
): Promise<void> => {
  const parentPath = dirname(filePath);
  const rootPath = parse(parentPath).root;
  const components = parentPath
    .slice(rootPath.length)
    .split(sep)
    .filter((component) => component.length > 0);
  let currentPath = rootPath;
  let currentStats = await lstat(rootPath, { bigint: true });
  for (const component of components) {
    const rootOwnedSymlink =
      currentStats.isSymbolicLink() && currentStats.uid === 0n;
    if (!currentStats.isDirectory() && !rootOwnedSymlink) {
      throw new ManagedBetterAuthProvisioningError(
        "Managed API-key provisioning rejects symbolic links in the requested directory chain.",
      );
    }
    if (currentStats.uid !== 0n && currentStats.uid !== currentUserId()) {
      throw new ManagedBetterAuthProvisioningError(
        "Managed API-key provisioning requires every requested-path ancestor to be owned by the effective user or root.",
      );
    }
    const currentMode = currentStats.mode & BigInt(FILE_PERMISSION_MASK);
    currentPath = join(currentPath, component);
    const childStats = await lstat(currentPath, { bigint: true });
    if (childStats.isSymbolicLink() && childStats.uid !== 0n) {
      throw new ManagedBetterAuthProvisioningError(
        "Managed API-key provisioning rejects non-root-owned symbolic links in the requested directory chain.",
      );
    }
    if (
      !rootOwnedSymlink &&
      (currentMode & BigInt(GROUP_OR_OTHER_WRITE_MASK)) !== 0n &&
      ((currentStats.mode & BigInt(STICKY_DIRECTORY_MODE)) === 0n ||
        childStats.uid !== currentUserId())
    ) {
      throw new ManagedBetterAuthProvisioningError(
        "Managed API-key provisioning requires a requested directory chain that cannot be replaced by group or other users.",
      );
    }
    currentStats = childStats;
  }
  if (
    (!currentStats.isDirectory() &&
      !(currentStats.isSymbolicLink() && currentStats.uid === 0n)) ||
    (currentStats.uid !== 0n && currentStats.uid !== currentUserId())
  ) {
    throw new ManagedBetterAuthProvisioningError(
      "Managed API-key provisioning requires every requested-path ancestor to be owned by the effective user or root.",
    );
  }
};

export const assertSecureParentDirectory = async (
  filePath: string,
): Promise<void> => {
  const parentPath = dirname(filePath);
  const rootPath = parse(parentPath).root;
  const components = parentPath
    .slice(rootPath.length)
    .split(sep)
    .filter((component) => component.length > 0);
  let currentPath = rootPath;
  let currentStats = await lstat(rootPath, { bigint: true });
  for (const component of components) {
    if (!currentStats.isDirectory()) {
      throw new ManagedBetterAuthProvisioningError(
        "Managed API-key provisioning rejects symbolic links in the environment directory chain.",
      );
    }
    if (currentStats.uid !== 0n && currentStats.uid !== currentUserId()) {
      throw new ManagedBetterAuthProvisioningError(
        "Managed API-key provisioning requires every ancestor to be owned by the effective user or root.",
      );
    }
    const childPath = join(currentPath, component);
    const childStats = await lstat(childPath, { bigint: true });
    if (!childStats.isDirectory()) {
      throw new ManagedBetterAuthProvisioningError(
        "Managed API-key provisioning rejects symbolic links in the environment directory chain.",
      );
    }
    const currentMode = currentStats.mode & BigInt(FILE_PERMISSION_MASK);
    if (
      (currentMode & BigInt(GROUP_OR_OTHER_WRITE_MASK)) !== 0n &&
      ((currentStats.mode & BigInt(STICKY_DIRECTORY_MODE)) === 0n ||
        childStats.uid !== currentUserId())
    ) {
      throw new ManagedBetterAuthProvisioningError(
        "Managed API-key provisioning requires a directory chain that cannot be replaced by group or other users.",
      );
    }
    currentPath = childPath;
    currentStats = childStats;
  }
  if (
    !currentStats.isDirectory() ||
    currentStats.uid !== currentUserId() ||
    (currentStats.mode & BigInt(GROUP_OR_OTHER_WRITE_MASK)) !== 0n
  ) {
    throw new ManagedBetterAuthProvisioningError(
      "Managed API-key provisioning requires a user-owned directory that is not writable by group or other users.",
    );
  }
};

const validateRegularFile = async (
  handle: FileHandle,
  subject: string,
): Promise<FileIdentity> => {
  const initialStats = await handle.stat({ bigint: true });
  if (
    !initialStats.isFile() ||
    initialStats.nlink !== 1n ||
    initialStats.uid !== currentUserId()
  ) {
    throw new ManagedBetterAuthProvisioningError(
      `${subject} must be a user-owned regular file with a single hard link.`,
    );
  }
  return identityFrom(initialStats);
};

export const restrictRegularFile = async (
  handle: FileHandle,
  identity: FileIdentity,
  subject: string,
): Promise<void> => {
  await handle.chmod(OWNER_ONLY_FILE_MODE);
  const securedStats = await handle.stat({ bigint: true });
  if (
    !hasIdentity(securedStats, identity) ||
    !securedStats.isFile() ||
    securedStats.nlink !== 1n ||
    securedStats.uid !== currentUserId() ||
    (securedStats.mode & BigInt(FILE_PERMISSION_MASK)) !==
      BigInt(OWNER_ONLY_FILE_MODE)
  ) {
    throw new ManagedBetterAuthProvisioningError(
      `${subject} permissions could not be restricted to its owner.`,
    );
  }
};

export const secureRegularFile = async (
  handle: FileHandle,
  subject: string,
): Promise<FileIdentity> => {
  const identity = await validateRegularFile(handle, subject);
  await restrictRegularFile(handle, identity, subject);
  return identity;
};

export const assertPathIdentity = async (
  filePath: string,
  identity: FileIdentity,
): Promise<void> => {
  let pathStats;
  try {
    pathStats = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    throw new ManagedBetterAuthProvisioningError(
      "Managed API-key environment path changed during provisioning.",
    );
  }
  if (
    !pathStats.isFile() ||
    pathStats.nlink !== 1n ||
    pathStats.uid !== currentUserId() ||
    !hasIdentity(pathStats, identity)
  ) {
    throw new ManagedBetterAuthProvisioningError(
      "Managed API-key environment path changed during provisioning.",
    );
  }
};

const openFlags =
  fileSystemConstants.O_APPEND |
  fileSystemConstants.O_NOFOLLOW |
  fileSystemConstants.O_RDWR;

export const openEnvironmentFile = async (
  filePath: string,
): Promise<OpenEnvironmentFile> => {
  let handle: FileHandle;
  let created = false;
  try {
    handle = await open(filePath, openFlags);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    try {
      handle = await open(
        filePath,
        openFlags | fileSystemConstants.O_CREAT | fileSystemConstants.O_EXCL,
        OWNER_ONLY_FILE_MODE,
      );
      created = true;
    } catch (createError) {
      if (!hasErrorCode(createError, "EEXIST")) throw createError;
      handle = await open(filePath, openFlags);
    }
  }

  try {
    const identity = await validateRegularFile(
      handle,
      "Managed API-key environment path",
    );
    return Object.freeze({ created, handle, identity });
  } catch (error) {
    const cleanupFailures = await collectFailures([() => handle.close()]);
    throw combineFailure(error, cleanupFailures);
  }
};

export const openReplacementEnvironmentFile = async (
  envFilePath: string,
): Promise<ReplacementEnvironmentFile> => {
  const replacementPath = `${envFilePath}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  const handle = await open(
    replacementPath,
    fileSystemConstants.O_CREAT |
      fileSystemConstants.O_EXCL |
      fileSystemConstants.O_NOFOLLOW |
      fileSystemConstants.O_RDWR,
    OWNER_ONLY_FILE_MODE,
  );
  return Object.freeze({ handle, path: replacementPath });
};

export const unlinkIfPresent = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
};
