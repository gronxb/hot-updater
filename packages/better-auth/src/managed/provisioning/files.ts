import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { type FileHandle, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export const FILE_MODE = 0o600;

export class ProvisioningError extends Error {
  readonly name = "ProvisioningError";

  constructor(message: string) {
    super(message);
  }
}

export type FileIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
};

export type OpenTarget = {
  readonly created: boolean;
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
};

const GROUP_OR_OTHER_WRITE = 0o022n;

export const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "code") === code;

export const unlinkIfPresent = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
};

export const assertNodePosix = (): void => {
  if (
    process.release.name !== "node" ||
    process.platform === "win32" ||
    process.geteuid === undefined ||
    typeof fsConstants.O_NOFOLLOW !== "number"
  ) {
    throw new ProvisioningError(
      "Managed API-key provisioning requires Node POSIX owner-only permissions.",
    );
  }
};

const currentUserId = (): bigint => {
  const getEffectiveUserId = process.geteuid;
  if (getEffectiveUserId === undefined) {
    throw new ProvisioningError(
      "Managed API-key provisioning requires POSIX user ownership metadata.",
    );
  }
  return BigInt(getEffectiveUserId());
};

export const assertSecureParent = async (
  envFilePath: string,
): Promise<void> => {
  const stats = await lstat(dirname(envFilePath), { bigint: true });
  if (
    !stats.isDirectory() ||
    stats.uid !== currentUserId() ||
    (stats.mode & GROUP_OR_OTHER_WRITE) !== 0n
  ) {
    throw new ProvisioningError(
      "Managed API-key provisioning requires a user-owned directory that is not writable by group or other users.",
    );
  }
};

const identityFrom = (stats: {
  readonly dev: bigint;
  readonly ino: bigint;
}): FileIdentity => ({ dev: stats.dev, ino: stats.ino });

const hasIdentity = (
  stats: { readonly dev: bigint; readonly ino: bigint },
  identity: FileIdentity,
): boolean => stats.dev === identity.dev && stats.ino === identity.ino;

export const validateFile = async (
  handle: FileHandle,
  subject: string,
): Promise<FileIdentity> => {
  const stats = await handle.stat({ bigint: true });
  if (!stats.isFile() || stats.nlink !== 1n || stats.uid !== currentUserId()) {
    throw new ProvisioningError(
      `${subject} must be a user-owned regular file with a single hard link.`,
    );
  }
  return identityFrom(stats);
};

export const hardenFile = async (
  handle: FileHandle,
  identity: FileIdentity,
  subject: string,
): Promise<void> => {
  await handle.chmod(FILE_MODE);
  const stats = await handle.stat({ bigint: true });
  if (
    !stats.isFile() ||
    stats.nlink !== 1n ||
    stats.uid !== currentUserId() ||
    !hasIdentity(stats, identity) ||
    (stats.mode & 0o777n) !== BigInt(FILE_MODE)
  ) {
    throw new ProvisioningError(
      `${subject} permissions could not be set to 0600.`,
    );
  }
};

export const assertPathIdentity = async (
  filePath: string,
  identity: FileIdentity,
): Promise<void> => {
  const stats = await lstat(filePath, { bigint: true });
  if (
    !stats.isFile() ||
    stats.nlink !== 1n ||
    stats.uid !== currentUserId() ||
    !hasIdentity(stats, identity)
  ) {
    throw new ProvisioningError(
      "Managed API-key environment path changed during provisioning.",
    );
  }
};

const openVerified = async (
  filePath: string,
  flags: number,
  subject: string,
): Promise<readonly [FileHandle, FileIdentity]> => {
  const handle = await open(filePath, flags, FILE_MODE);
  try {
    return [handle, await validateFile(handle, subject)];
  } catch (error) {
    await handle.close();
    throw error;
  }
};

export const openTarget = async (envFilePath: string): Promise<OpenTarget> => {
  while (true) {
    try {
      const [handle, identity] = await openVerified(
        envFilePath,
        fsConstants.O_NOFOLLOW | fsConstants.O_RDONLY,
        "Managed API-key environment path",
      );
      return { created: false, handle, identity };
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    try {
      const [handle, identity] = await openVerified(
        envFilePath,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW |
          fsConstants.O_RDWR,
        "Managed API-key environment path",
      );
      return { created: true, handle, identity };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
};

export const writeReplacement = async (
  envFilePath: string,
  originalIdentity: FileIdentity,
  content: string,
): Promise<void> => {
  const temporaryPath = `${envFilePath}.${randomBytes(16).toString("hex")}.tmp`;
  const [temporary, identity] = await openVerified(
    temporaryPath,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW |
      fsConstants.O_RDWR,
    "Managed API-key replacement environment path",
  );
  let renamed = false;
  try {
    await hardenFile(temporary, identity, "replacement environment path");
    await temporary.writeFile(content, "utf8");
    await temporary.sync();
    await assertPathIdentity(envFilePath, originalIdentity);
    await rename(temporaryPath, envFilePath);
    renamed = true;
    await assertPathIdentity(envFilePath, identity);
  } finally {
    await temporary.close();
    if (!renamed) await unlinkIfPresent(temporaryPath);
  }
};
