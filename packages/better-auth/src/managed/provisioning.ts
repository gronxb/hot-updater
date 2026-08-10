import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { isCanonicalBase64Url32 } from "../base64url";
import {
  MANAGED_ACCESS_KEY_ENV_NAME,
  registerManagedAccessKey,
  type ManagedAccessKeyRecord,
  type ManagedAccessKeyStore,
} from "./accessKeys";
import {
  assertNodePosix,
  assertPathIdentity,
  assertSecureParent,
  hardenFile,
  openTarget,
  ProvisioningError,
  writeReplacement,
} from "./provisioning/files";
import { withExclusiveLock } from "./provisioning/lock";

export const HOT_UPDATER_API_KEY_ENV_NAME = MANAGED_ACCESS_KEY_ENV_NAME;

export type ProvisionManagedBetterAuthApiKeyOptions = {
  readonly envFilePath?: string;
  readonly name?: string;
  readonly store?: ManagedAccessKeyStore;
};

export type ProvisionedManagedBetterAuthApiKey = {
  readonly apiKey: string;
  readonly created: boolean;
  readonly record?: ManagedAccessKeyRecord;
  readonly sha256: string;
};

export type CreatedManagedBetterAuthApiKey = {
  readonly apiKey: string;
  readonly record: ManagedAccessKeyRecord;
};

const MAX_ENV_FILE_BYTES = 1_048_576n;
const keyLinePattern = new RegExp(
  `^\\s*(?:export\\s+)?${HOT_UPDATER_API_KEY_ENV_NAME}\\s*=\\s*(.*?)\\s*$`,
  "u",
);
const pendingProvisioning = new Map<
  string,
  Promise<ProvisionedManagedBetterAuthApiKey>
>();

const readExistingKey = (content: string): string | undefined => {
  const keys = content.split(/\r?\n/u).flatMap((line) => {
    const match = keyLinePattern.exec(line);
    return match === null ? [] : [match[1] ?? ""];
  });
  if (keys.length > 1) {
    throw new ProvisioningError(
      `.env.hotupdater contains multiple ${HOT_UPDATER_API_KEY_ENV_NAME} definitions.`,
    );
  }
  const key = keys[0];
  if (key === undefined) return undefined;
  if (!isCanonicalBase64Url32(key)) {
    throw new ProvisioningError(
      `${HOT_UPDATER_API_KEY_ENV_NAME} must be a canonical 32-byte base64url value.`,
    );
  }
  return key;
};

const resultFor = (
  apiKey: string,
  created: boolean,
): ProvisionedManagedBetterAuthApiKey => ({
  apiKey,
  created,
  sha256: createHash("sha256").update(apiKey).digest("base64url"),
});

const nextContent = (content: string, apiKey: string): string =>
  `${content}${content.length === 0 || content.endsWith("\n") ? "" : "\n"}${HOT_UPDATER_API_KEY_ENV_NAME}=${apiKey}\n`;

const provision = async (
  envFilePath: string,
): Promise<ProvisionedManagedBetterAuthApiKey> =>
  withExclusiveLock(envFilePath, async () => {
    const target = await openTarget(envFilePath);
    try {
      const stats = await target.handle.stat({ bigint: true });
      if (stats.size > MAX_ENV_FILE_BYTES) {
        throw new ProvisioningError(
          "Managed API-key environment file exceeds the 1 MiB provisioning limit.",
        );
      }
      const content = await target.handle.readFile("utf8");
      const existingKey = readExistingKey(content);
      if (existingKey !== undefined) {
        await hardenFile(target.handle, target.identity, "environment path");
        await assertPathIdentity(envFilePath, target.identity);
        return resultFor(existingKey, false);
      }
      const apiKey = randomBytes(32).toString("base64url");
      const contentWithKey = nextContent(content, apiKey);
      if (target.created) {
        await hardenFile(target.handle, target.identity, "environment path");
        await target.handle.writeFile(contentWithKey, "utf8");
        await target.handle.sync();
        await assertPathIdentity(envFilePath, target.identity);
      } else {
        await writeReplacement(envFilePath, target.identity, contentWithKey);
      }
      return resultFor(apiKey, true);
    } finally {
      await target.handle.close();
    }
  });

export const provisionManagedBetterAuthApiKey = async (
  options: ProvisionManagedBetterAuthApiKeyOptions = {},
): Promise<ProvisionedManagedBetterAuthApiKey> => {
  assertNodePosix();
  const envFilePath = resolve(options.envFilePath ?? ".env.hotupdater");
  await assertSecureParent(envFilePath);
  const existing = pendingProvisioning.get(envFilePath);
  const pending = existing ?? provision(envFilePath);
  if (existing === undefined) pendingProvisioning.set(envFilePath, pending);
  try {
    const result = await pending;
    if (options.store === undefined) return result;
    const record = await registerManagedAccessKey({
      apiKey: result.apiKey,
      name: options.name ?? "Default",
      store: options.store,
    });
    return { ...result, record };
  } finally {
    if (pendingProvisioning.get(envFilePath) === pending) {
      pendingProvisioning.delete(envFilePath);
    }
  }
};

export const createManagedBetterAuthApiKey = async (options: {
  readonly name: string;
  readonly store: ManagedAccessKeyStore;
}): Promise<CreatedManagedBetterAuthApiKey> => {
  assertNodePosix();
  const apiKey = randomBytes(32).toString("base64url");
  const record = await registerManagedAccessKey({
    apiKey,
    name: options.name,
    store: options.store,
  });
  return { apiKey, record };
};
