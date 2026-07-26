import {
  assertInitInputs,
  getHotUpdaterEnvValue,
} from "@hot-updater/cli-tools";

import { regionLocationMap } from "./regionLocationMap";

export const AWS_AUTH_MODES = [
  "local-session",
  "shared-profile",
  "sso",
  "account",
] as const;

export type AwsAuthMode = (typeof AWS_AUTH_MODES)[number];

export type AwsInitInputs = {
  readonly accessKeyId?: string;
  readonly authMode?: AwsAuthMode;
  readonly bucketName?: string;
  readonly bucketRegion?: string;
  readonly distributionId?: string;
  readonly lambdaName?: string;
  readonly migrationApproved?: string;
  readonly profile?: string;
  readonly secretAccessKey?: string;
};

export const isAwsAuthMode = (
  value: string | undefined,
): value is AwsAuthMode => AWS_AUTH_MODES.some((mode) => mode === value);

export const resolveAwsInitInputs = (
  existingEnv: Readonly<Record<string, string>>,
  inputEnv: Readonly<Record<string, string>> = {},
): AwsInitInputs => {
  const savedAuthMode = getHotUpdaterEnvValue(
    existingEnv,
    "HOT_UPDATER_AWS_AUTH_MODE",
  );

  return {
    accessKeyId: getHotUpdaterEnvValue(
      existingEnv,
      "HOT_UPDATER_S3_ACCESS_KEY_ID",
    ),
    authMode: isAwsAuthMode(savedAuthMode) ? savedAuthMode : undefined,
    bucketName: getHotUpdaterEnvValue(
      existingEnv,
      "HOT_UPDATER_S3_BUCKET_NAME",
    ),
    bucketRegion: getHotUpdaterEnvValue(existingEnv, "HOT_UPDATER_S3_REGION"),
    distributionId: getHotUpdaterEnvValue(
      existingEnv,
      "HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID",
    ),
    lambdaName: getHotUpdaterEnvValue(
      existingEnv,
      "HOT_UPDATER_AWS_LAMBDA_NAME",
    ),
    migrationApproved:
      process.env.HOT_UPDATER_AWS_MIGRATION_APPROVED?.trim() === "true" ||
      inputEnv.HOT_UPDATER_AWS_MIGRATION_APPROVED?.trim() === "true"
        ? "true"
        : undefined,
    profile: getHotUpdaterEnvValue(existingEnv, "HOT_UPDATER_AWS_PROFILE"),
    secretAccessKey: getHotUpdaterEnvValue(
      existingEnv,
      "HOT_UPDATER_S3_SECRET_ACCESS_KEY",
    ),
  };
};

export const assertAwsNonInteractiveInputs = (
  inputs: AwsInitInputs,
  nonInteractive: boolean,
): void => {
  assertInitInputs({
    inputs: {
      HOT_UPDATER_AWS_AUTH_MODE: inputs.authMode,
      HOT_UPDATER_S3_BUCKET_NAME: inputs.bucketName,
      HOT_UPDATER_S3_REGION:
        inputs.bucketRegion &&
        Object.hasOwn(regionLocationMap, inputs.bucketRegion)
          ? inputs.bucketRegion
          : undefined,
      HOT_UPDATER_AWS_LAMBDA_NAME: inputs.lambdaName,
      HOT_UPDATER_AWS_MIGRATION_APPROVED: inputs.migrationApproved,
      ...(inputs.authMode === "account"
        ? {
            HOT_UPDATER_S3_ACCESS_KEY_ID: inputs.accessKeyId,
            HOT_UPDATER_S3_SECRET_ACCESS_KEY: inputs.secretAccessKey,
          }
        : {}),
      ...(inputs.authMode === "shared-profile" || inputs.authMode === "sso"
        ? { HOT_UPDATER_AWS_PROFILE: inputs.profile }
        : {}),
    },
    strict: nonInteractive,
  });
};
