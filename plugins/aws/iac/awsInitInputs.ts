import {
  assertInitProviderInputs,
  AWS_AUTH_MODES,
  AWS_INIT_PROVIDER,
  isAwsAuthMode,
  resolveInitProviderInput,
} from "@hot-updater/cli-tools";

import { regionLocationMap } from "./regionLocationMap";

export { AWS_AUTH_MODES, isAwsAuthMode };

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

export const resolveAwsInitInputs = (
  existingEnv: Readonly<Record<string, string>>,
): AwsInitInputs => {
  const { inputs } = AWS_INIT_PROVIDER;
  const savedAuthMode = resolveInitProviderInput(existingEnv, inputs.authMode);

  return {
    accessKeyId: resolveInitProviderInput(existingEnv, inputs.accessKeyId),
    authMode: isAwsAuthMode(savedAuthMode) ? savedAuthMode : undefined,
    bucketName: resolveInitProviderInput(existingEnv, inputs.bucketName),
    bucketRegion: resolveInitProviderInput(existingEnv, inputs.bucketRegion),
    distributionId: resolveInitProviderInput(
      existingEnv,
      inputs.distributionId,
    ),
    lambdaName: resolveInitProviderInput(existingEnv, inputs.lambdaName),
    migrationApproved: resolveInitProviderInput(
      existingEnv,
      inputs.migrationApproved,
    ),
    profile: resolveInitProviderInput(existingEnv, inputs.profile),
    secretAccessKey: resolveInitProviderInput(
      existingEnv,
      inputs.secretAccessKey,
    ),
  };
};

export const assertAwsNonInteractiveInputs = (
  inputs: AwsInitInputs,
  nonInteractive: boolean,
): void => {
  assertInitProviderInputs({
    inputs: {
      ...inputs,
      bucketRegion:
        inputs.bucketRegion &&
        Object.hasOwn(regionLocationMap, inputs.bucketRegion)
          ? inputs.bucketRegion
          : undefined,
    },
    provider: AWS_INIT_PROVIDER,
    strict: nonInteractive,
  });
};
