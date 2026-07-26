import { createHash, randomBytes } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

import { isCanonicalBase64Url32 } from "../base64url";

export const HOT_UPDATER_API_KEY_ENV_NAME = "HOT_UPDATER_API_KEY";

export type ProvisionManagedBetterAuthApiKeyOptions = {
  readonly envFilePath?: string;
};

export type ProvisionedManagedBetterAuthApiKey = {
  readonly apiKey: string;
  readonly sha256: string;
};

class ManagedBetterAuthProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedBetterAuthProvisioningError";
  }
}

const envLinePattern = new RegExp(
  `^\\s*(?:export\\s+)?${HOT_UPDATER_API_KEY_ENV_NAME}\\s*=(.*)$`,
  "u",
);

const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const FILE_PERMISSION_MASK = 0o777;
const GROUP_OR_OTHER_WRITE_MASK = 0o022;
const STICKY_DIRECTORY_MODE = 0o1000;
const MAX_ENV_FILE_BYTES = 1_048_576n;
const LOCK_RETRY_INTERVAL_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_OWNER_PATTERN = /^owner-([1-9]\d*)-([a-f0-9]{32})$/u;

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "code") === code;

type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
}>;

type OpenEnvironmentFile = Readonly<{
  handle: FileHandle;
  identity: FileIdentity;
}>;

type ProvisioningLock = Readonly<{
  ownerEntryPath: string;
  path: string;
}>;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });

type AsyncOutcome<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ error: unknown; ok: false }>;

const captureOutcome = async <Value>(
  operation: () => Promise<Value>,
): Promise<AsyncOutcome<Value>> => {
  try {
    return Object.freeze({ ok: true, value: await operation() });
  } catch (error) {
    return Object.freeze({ error, ok: false });
  }
};

const captureFailure = async (
  operation: () => Promise<void>,
): Promise<unknown | undefined> => {
  const outcome = await captureOutcome(operation);
  return outcome.ok ? undefined : outcome.error;
};

const collectFailures = async (
  operations: ReadonlyArray<() => Promise<void>>,
): Promise<readonly unknown[]> => {
  const failures: unknown[] = [];
  for (const operation of operations) {
    const failure = await captureFailure(operation);
    if (failure !== undefined) failures.push(failure);
  }
  return Object.freeze(failures);
};

const combineFailure = (
  primary: unknown,
  cleanupFailures: readonly unknown[],
): unknown => {
  if (cleanupFailures.length === 0) return primary;
  const message =
    primary instanceof Error
      ? primary.message
      : "Managed API-key provisioning failed.";
  return new AggregateError([primary, ...cleanupFailures], message, {
    cause: primary,
  });
};

const finishOutcome = <Value>(
  outcome: AsyncOutcome<Value>,
  cleanupFailures: readonly unknown[],
  cleanupMessage: string,
): Value => {
  if (!outcome.ok) throw combineFailure(outcome.error, cleanupFailures);
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, cleanupMessage, {
      cause: cleanupFailures[0],
    });
  }
  return outcome.value;
};

const assertPermissionHardeningSupported = (): void => {
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

const identityFrom = (stats: {
  readonly dev: bigint;
  readonly ino: bigint;
}): FileIdentity => {
  return Object.freeze({ dev: stats.dev, ino: stats.ino });
};

const hasIdentity = (
  stats: { readonly dev: bigint; readonly ino: bigint },
  identity: FileIdentity,
): boolean => stats.dev === identity.dev && stats.ino === identity.ino;

const pathHasIdentity = async (
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

const currentUserId = (): bigint => {
  const getEffectiveUserId = process.geteuid;
  if (getEffectiveUserId === undefined) {
    throw new ManagedBetterAuthProvisioningError(
      "Managed API-key provisioning requires POSIX user ownership metadata.",
    );
  }
  return BigInt(getEffectiveUserId());
};

const assertTrustedRequestedDirectoryChain = async (
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

const assertSecureParentDirectory = async (filePath: string): Promise<void> => {
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

const restrictRegularFile = async (
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

const secureRegularFile = async (
  handle: FileHandle,
  subject: string,
): Promise<FileIdentity> => {
  const identity = await validateRegularFile(handle, subject);
  await restrictRegularFile(handle, identity, subject);
  return identity;
};

const assertPathIdentity = async (
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

const openEnvironmentFile = async (
  filePath: string,
): Promise<OpenEnvironmentFile> => {
  let handle: FileHandle;
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
    } catch (createError) {
      if (!hasErrorCode(createError, "EEXIST")) throw createError;
      handle = await open(filePath, openFlags);
    }
  }

  let identity: FileIdentity | undefined;
  try {
    identity = await validateRegularFile(
      handle,
      "Managed API-key environment path",
    );
    return Object.freeze({ handle, identity });
  } catch (error) {
    const cleanupFailures = await collectFailures([() => handle.close()]);
    throw combineFailure(error, cleanupFailures);
  }
};

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

const unlinkIfPresent = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
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

const closeEnvironmentFile = async (
  opened: OpenEnvironmentFile,
): Promise<readonly unknown[]> =>
  collectFailures([() => opened.handle.close()]);

const rollbackAppend = async (
  handle: FileHandle,
  originalSize: bigint,
): Promise<void> => {
  await handle.truncate(Number(originalSize));
  await handle.sync();
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  const first = trimmed.at(0);
  if (
    (first === '"' || first === "'") &&
    trimmed.at(-1) === first &&
    trimmed.length >= 2
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const readExistingApiKey = (content: string): string | undefined => {
  const values = content.split(/\r?\n/u).flatMap((line) => {
    const match = envLinePattern.exec(line);
    return match === null ? [] : [unquote(match[1] ?? "")];
  });
  if (values.length > 1) {
    throw new ManagedBetterAuthProvisioningError(
      `.env.hotupdater contains multiple ${HOT_UPDATER_API_KEY_ENV_NAME} definitions.`,
    );
  }
  const value = values[0];
  if (value === undefined) return undefined;
  if (!isCanonicalBase64Url32(value)) {
    throw new ManagedBetterAuthProvisioningError(
      `${HOT_UPDATER_API_KEY_ENV_NAME} must be a canonical 32-byte base64url value.`,
    );
  }
  return value;
};

const resultFor = (apiKey: string): ProvisionedManagedBetterAuthApiKey =>
  Object.freeze({
    apiKey,
    sha256: createHash("sha256").update(apiKey).digest("base64url"),
  });

const provisionEnvironmentFile = async (
  envFilePath: string,
): Promise<ProvisionedManagedBetterAuthApiKey> => {
  await assertSecureParentDirectory(envFilePath);
  const opened = await openEnvironmentFile(envFilePath);
  const outcome = await captureOutcome(async () => {
    await assertSecureParentDirectory(envFilePath);
    await assertPathIdentity(envFilePath, opened.identity);
    await restrictRegularFile(
      opened.handle,
      opened.identity,
      "Managed API-key environment path",
    );
    await assertSecureParentDirectory(envFilePath);
    await assertPathIdentity(envFilePath, opened.identity);
    const stats = await opened.handle.stat({ bigint: true });
    if (stats.size > MAX_ENV_FILE_BYTES) {
      throw new ManagedBetterAuthProvisioningError(
        "Managed API-key environment file exceeds the 1 MiB provisioning limit.",
      );
    }
    const content = await opened.handle.readFile("utf8");
    const existing = readExistingApiKey(content);
    if (existing !== undefined) {
      await assertPathIdentity(envFilePath, opened.identity);
      return resultFor(existing);
    }

    const apiKey = randomBytes(32).toString("base64url");
    const separator =
      content.length === 0 || content.endsWith("\n") ? "" : "\n";
    try {
      await opened.handle.writeFile(
        `${separator}${HOT_UPDATER_API_KEY_ENV_NAME}=${apiKey}\n`,
        "utf8",
      );
      await opened.handle.sync();
      await assertPathIdentity(envFilePath, opened.identity);
    } catch (error) {
      const rollbackFailure = await captureFailure(() =>
        rollbackAppend(opened.handle, stats.size),
      );
      throw combineFailure(
        error,
        rollbackFailure === undefined ? [] : [rollbackFailure],
      );
    }
    return resultFor(apiKey);
  });
  const cleanupFailures = await closeEnvironmentFile(opened);
  return finishOutcome(
    outcome,
    cleanupFailures,
    "Managed API-key environment cleanup failed.",
  );
};

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
  const lock = await acquireProvisioningLock(envFilePath);
  const directoryOutcome = await captureOutcome(() =>
    assertSecureParentDirectory(envFilePath),
  );
  if (!directoryOutcome.ok) {
    const cleanupFailures = await releaseProvisioningLock(lock);
    throw combineFailure(directoryOutcome.error, cleanupFailures);
  }
  const outcome = await captureOutcome(() =>
    provisionEnvironmentFile(envFilePath),
  );
  const cleanupFailures = await releaseProvisioningLock(lock);
  return finishOutcome(
    outcome,
    cleanupFailures,
    "Managed API-key provisioning lock cleanup failed.",
  );
};
