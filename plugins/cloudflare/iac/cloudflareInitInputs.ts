import {
  assertInitProviderInputs,
  CLOUDFLARE_INIT_PROVIDER,
  resolveInitProviderInput,
} from "@hot-updater/cli-tools";

export type CloudflareInitInputs = {
  readonly accessKeyId?: string;
  readonly accountId?: string;
  readonly apiToken?: string;
  readonly bucketName?: string;
  readonly d1DatabaseId?: string;
  readonly d1DatabaseName?: string;
  readonly r2Private?: string;
  readonly secretAccessKey?: string;
  readonly workerName?: string;
};

export const shouldUpdateR2ManagedDomain = ({
  isPrivate,
  managedDomainEnabled,
}: {
  readonly isPrivate: boolean;
  readonly managedDomainEnabled: boolean;
}) => managedDomainEnabled !== !isPrivate;

export const resolveCloudflareInitInputs = (
  existingEnv: Readonly<Record<string, string>>,
): CloudflareInitInputs => {
  const { inputs } = CLOUDFLARE_INIT_PROVIDER;

  return {
    accessKeyId: resolveInitProviderInput(existingEnv, inputs.accessKeyId),
    accountId: resolveInitProviderInput(existingEnv, inputs.accountId),
    apiToken: resolveInitProviderInput(existingEnv, inputs.apiToken),
    bucketName: resolveInitProviderInput(existingEnv, inputs.bucketName),
    d1DatabaseId: resolveInitProviderInput(existingEnv, inputs.d1DatabaseId),
    d1DatabaseName: resolveInitProviderInput(
      existingEnv,
      inputs.d1DatabaseName,
    ),
    r2Private: resolveInitProviderInput(existingEnv, inputs.r2Private),
    secretAccessKey: resolveInitProviderInput(
      existingEnv,
      inputs.secretAccessKey,
    ),
    workerName: resolveInitProviderInput(existingEnv, inputs.workerName),
  };
};

export const assertCloudflareNonInteractiveInputs = (
  inputs: CloudflareInitInputs,
  nonInteractive: boolean,
): void => {
  assertInitProviderInputs({
    inputs,
    provider: CLOUDFLARE_INIT_PROVIDER,
    strict: nonInteractive,
  });
};
