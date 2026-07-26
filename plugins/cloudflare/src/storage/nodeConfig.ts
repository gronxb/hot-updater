import {
  isConfigReference,
  resolveConfigReference,
} from "@hot-updater/core/config";
import {
  StoragePluginError,
  type StorageOperationContext,
} from "@hot-updater/plugin-core/storage";

import type {
  R2CredentialsConfig,
  R2NodeStorageConfig,
  ResolvedR2NodeStorageConfig,
} from "./nodeTypes";
import { hasConfigReference, resolveStringConfig } from "./shared";

const parseCredentials = (
  value: string,
): ResolvedR2NodeStorageConfig["credentials"] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new StoragePluginError(
      "invalid-input",
      "Resolved Cloudflare R2 credentials must be a JSON object.",
      { cause: error },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("accessKeyId" in parsed) ||
    typeof parsed.accessKeyId !== "string" ||
    !("secretAccessKey" in parsed) ||
    typeof parsed.secretAccessKey !== "string" ||
    ("sessionToken" in parsed &&
      parsed.sessionToken !== undefined &&
      typeof parsed.sessionToken !== "string")
  ) {
    throw new StoragePluginError(
      "invalid-input",
      "Resolved Cloudflare R2 credentials have an invalid shape.",
    );
  }
  const sessionToken =
    "sessionToken" in parsed ? parsed.sessionToken : undefined;
  return {
    accessKeyId: parsed.accessKeyId,
    secretAccessKey: parsed.secretAccessKey,
    ...(typeof sessionToken === "string" ? { sessionToken } : {}),
  };
};

const resolveCredentials = (
  credentials: R2CredentialsConfig,
  context: StorageOperationContext,
): ResolvedR2NodeStorageConfig["credentials"] => {
  if (typeof credentials === "function") {
    return credentials;
  }
  if (isConfigReference(credentials)) {
    return parseCredentials(
      resolveConfigReference<string>(credentials, context),
    );
  }
  return {
    accessKeyId: resolveStringConfig(credentials.accessKeyId, context),
    secretAccessKey: resolveStringConfig(credentials.secretAccessKey, context),
    ...(credentials.sessionToken === undefined
      ? {}
      : {
          sessionToken: resolveStringConfig(credentials.sessionToken, context),
        }),
  };
};

export const hasTaggedR2NodeOptions = (config: R2NodeStorageConfig): boolean =>
  hasConfigReference(config.accountId) ||
  hasConfigReference(config.bucketName) ||
  hasConfigReference(config.credentials) ||
  hasConfigReference(config.basePath) ||
  hasConfigReference(config.endpoint) ||
  hasConfigReference(config.publicBaseUrl) ||
  hasConfigReference(config.region);

export const resolveR2NodeConfig = (
  config: R2NodeStorageConfig,
  context: StorageOperationContext,
): ResolvedR2NodeStorageConfig => {
  const accountId = resolveStringConfig(config.accountId, context);
  return {
    accountId,
    bucketName: resolveStringConfig(config.bucketName, context),
    credentials: resolveCredentials(config.credentials, context),
    ...(config.basePath === undefined
      ? {}
      : { basePath: resolveStringConfig(config.basePath, context) }),
    endpoint:
      config.endpoint === undefined
        ? `https://${accountId}.r2.cloudflarestorage.com`
        : resolveStringConfig(config.endpoint, context),
    ...(config.publicBaseUrl === undefined
      ? {}
      : {
          publicBaseUrl: resolveStringConfig(config.publicBaseUrl, context),
        }),
    forcePathStyle: config.forcePathStyle ?? true,
    region:
      config.region === undefined
        ? "auto"
        : resolveStringConfig(config.region, context),
  };
};
