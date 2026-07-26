import { createHash, randomBytes } from "node:crypto";
import { type FileHandle, rename } from "node:fs/promises";

import { isCanonicalBase64Url32 } from "../../base64url";
import {
  assertPathIdentity,
  assertSecureParentDirectory,
  openEnvironmentFile,
  openReplacementEnvironmentFile,
  type ReplacementEnvironmentFile,
  restrictRegularFile,
  secureRegularFile,
  unlinkIfPresent,
} from "./fileSecurity";
import { withProvisioningLock } from "./lock";
import {
  captureFailure,
  captureOutcome,
  collectFailures,
  combineFailure,
  finishOutcome,
  HOT_UPDATER_API_KEY_ENV_NAME,
  ManagedBetterAuthProvisioningError,
  type ProvisionedManagedBetterAuthApiKey,
} from "./shared";

const MAX_ENV_FILE_BYTES = 1_048_576n;
const envLinePattern = new RegExp(
  `^\\s*(?:export\\s+)?${HOT_UPDATER_API_KEY_ENV_NAME}\\s*=(.*)$`,
  "u",
);

const rollbackWrite = async (
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
  let replacement: ReplacementEnvironmentFile | undefined;
  const outcome = await captureOutcome(async () => {
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
      await restrictRegularFile(
        opened.handle,
        opened.identity,
        "Managed API-key environment path",
      );
      await assertSecureParentDirectory(envFilePath);
      await assertPathIdentity(envFilePath, opened.identity);
      return resultFor(existing);
    }

    const apiKey = randomBytes(32).toString("base64url");
    const separator =
      content.length === 0 || content.endsWith("\n") ? "" : "\n";
    const nextContent = `${content}${separator}${HOT_UPDATER_API_KEY_ENV_NAME}=${apiKey}\n`;
    if (!opened.created) {
      const replacementFile = await openReplacementEnvironmentFile(envFilePath);
      replacement = replacementFile;
      const replacementIdentity = await secureRegularFile(
        replacementFile.handle,
        "Managed API-key replacement environment path",
      );
      try {
        await replacementFile.handle.writeFile(nextContent, "utf8");
        await replacementFile.handle.sync();
      } catch (error) {
        const rollbackFailure = await captureFailure(() =>
          rollbackWrite(replacementFile.handle, 0n),
        );
        throw combineFailure(
          error,
          rollbackFailure === undefined ? [] : [rollbackFailure],
        );
      }
      await assertSecureParentDirectory(envFilePath);
      await assertPathIdentity(envFilePath, opened.identity);
      await assertPathIdentity(replacementFile.path, replacementIdentity);
      await rename(replacementFile.path, envFilePath);
      await assertSecureParentDirectory(envFilePath);
      await assertPathIdentity(envFilePath, replacementIdentity);
      return resultFor(apiKey);
    }

    await restrictRegularFile(
      opened.handle,
      opened.identity,
      "Managed API-key environment path",
    );
    await assertSecureParentDirectory(envFilePath);
    await assertPathIdentity(envFilePath, opened.identity);
    try {
      await opened.handle.writeFile(
        `${separator}${HOT_UPDATER_API_KEY_ENV_NAME}=${apiKey}\n`,
        "utf8",
      );
      await opened.handle.sync();
      await assertPathIdentity(envFilePath, opened.identity);
    } catch (error) {
      const rollbackFailure = await captureFailure(() =>
        rollbackWrite(opened.handle, stats.size),
      );
      throw combineFailure(
        error,
        rollbackFailure === undefined ? [] : [rollbackFailure],
      );
    }
    return resultFor(apiKey);
  });
  const replacementForCleanup = replacement;
  const cleanupFailures = await collectFailures(
    replacementForCleanup === undefined
      ? [() => opened.handle.close()]
      : [
          () => replacementForCleanup.handle.close(),
          () => unlinkIfPresent(replacementForCleanup.path),
          () => opened.handle.close(),
        ],
  );
  return finishOutcome(
    outcome,
    cleanupFailures,
    "Managed API-key environment cleanup failed.",
  );
};

export const provisionCanonicalEnvironmentFile = async (
  envFilePath: string,
): Promise<ProvisionedManagedBetterAuthApiKey> =>
  withProvisioningLock(envFilePath, () =>
    provisionEnvironmentFile(envFilePath),
  );
