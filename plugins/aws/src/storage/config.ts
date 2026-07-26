import {
  isConfigReference,
  resolveConfigReference,
} from "@hot-updater/core/config";
import {
  StoragePluginError,
  type StorageOperationContext,
} from "@hot-updater/plugin-core/storage";

import type {
  ResolvedS3StorageConfig,
  S3CredentialInput,
  S3CredentialsConfig,
  S3StorageConfig,
} from "./types";

const hasTaggedCredentials = (credentials: S3CredentialsConfig): boolean => {
  if (isConfigReference(credentials)) {
    return true;
  }
  if (typeof credentials === "function") {
    return false;
  }
  return (
    isConfigReference(credentials.accessKeyId) ||
    isConfigReference(credentials.secretAccessKey) ||
    isConfigReference(credentials.sessionToken)
  );
};

export const hasTaggedS3Options = (config: S3StorageConfig): boolean =>
  isConfigReference(config.bucketName) ||
  isConfigReference(config.basePath) ||
  isConfigReference(config.region) ||
  isConfigReference(config.endpoint) ||
  (config.credentials !== undefined &&
    hasTaggedCredentials(config.credentials)) ||
  (config.delivery?.type === "cloudfront" &&
    (isConfigReference(config.delivery.publicBaseUrl) ||
      isConfigReference(config.delivery.keyPairId) ||
      isConfigReference(config.delivery.privateKey)));

const parseCredentials = (value: string): S3CredentialInput => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new StoragePluginError(
      "invalid-input",
      "Resolved AWS credentials must be a JSON object.",
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
      "Resolved AWS credentials have an invalid shape.",
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
  credentials: S3CredentialsConfig | undefined,
  context: StorageOperationContext,
): ResolvedS3StorageConfig["credentials"] => {
  if (credentials === undefined || typeof credentials === "function") {
    return credentials;
  }
  if (isConfigReference(credentials)) {
    return parseCredentials(
      resolveConfigReference<string>(credentials, context),
    );
  }
  return {
    accessKeyId: resolveConfigReference(credentials.accessKeyId, context),
    secretAccessKey: resolveConfigReference(
      credentials.secretAccessKey,
      context,
    ),
    ...(credentials.sessionToken === undefined
      ? {}
      : {
          sessionToken: resolveConfigReference(
            credentials.sessionToken,
            context,
          ),
        }),
  };
};

export const resolveS3Config = (
  config: S3StorageConfig,
  context: StorageOperationContext,
): ResolvedS3StorageConfig => {
  const delivery =
    config.delivery?.type === "cloudfront"
      ? {
          type: "cloudfront" as const,
          publicBaseUrl: resolveConfigReference(
            config.delivery.publicBaseUrl,
            context,
          ),
          keyPairId: resolveConfigReference(config.delivery.keyPairId, context),
          privateKey: resolveConfigReference(
            config.delivery.privateKey,
            context,
          ),
          ...(config.delivery.expiresInSeconds === undefined
            ? {}
            : { expiresInSeconds: config.delivery.expiresInSeconds }),
        }
      : config.delivery;

  return {
    bucketName: resolveConfigReference(config.bucketName, context),
    ...(config.basePath === undefined
      ? {}
      : { basePath: resolveConfigReference(config.basePath, context) }),
    ...(config.region === undefined
      ? {}
      : { region: resolveConfigReference(config.region, context) }),
    ...(config.endpoint === undefined
      ? {}
      : { endpoint: resolveConfigReference(config.endpoint, context) }),
    ...(config.credentials === undefined
      ? {}
      : { credentials: resolveCredentials(config.credentials, context) }),
    ...(config.forcePathStyle === undefined
      ? {}
      : { forcePathStyle: config.forcePathStyle }),
    ...(config.maxAttempts === undefined
      ? {}
      : { maxAttempts: config.maxAttempts }),
    ...(config.requestChecksumCalculation === undefined
      ? {}
      : { requestChecksumCalculation: config.requestChecksumCalculation }),
    ...(config.responseChecksumValidation === undefined
      ? {}
      : { responseChecksumValidation: config.responseChecksumValidation }),
    ...(delivery === undefined ? {} : { delivery }),
  };
};
