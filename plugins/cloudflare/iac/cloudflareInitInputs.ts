import {
  assertInitProviderInputs,
  resolveInitProviderInput,
} from "@hot-updater/cli-tools";

import { initProvider as CLOUDFLARE_INIT_PROVIDER } from "./init/index";

export type CloudflareInitInputs = {
  readonly accessKeyId?: string;
  readonly accountId?: string;
  readonly apiToken?: string;
  readonly bucketName?: string;
  readonly d1DatabaseId?: string;
  readonly d1DatabaseName?: string;
  readonly insightsDatabaseNamespace?: string;
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

export type R2PrivacyResolution =
  | {
      readonly isPrivate: boolean;
      readonly kind: "resolved";
    }
  | {
      readonly kind: "prompt";
    };

export const resolveR2Privacy = ({
  createBucket,
  managedDomainEnabled,
  savedPrivateSetting,
}: {
  readonly createBucket: boolean;
  readonly managedDomainEnabled?: boolean;
  readonly savedPrivateSetting?: string;
}): R2PrivacyResolution => {
  if (savedPrivateSetting === "true" || savedPrivateSetting === "false") {
    return {
      isPrivate: savedPrivateSetting === "true",
      kind: "resolved",
    };
  }
  if (!createBucket && managedDomainEnabled !== undefined) {
    return {
      isPrivate: !managedDomainEnabled,
      kind: "resolved",
    };
  }
  return { kind: "prompt" };
};

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
    insightsDatabaseNamespace: resolveInitProviderInput(
      existingEnv,
      inputs.insightsDatabaseNamespace,
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
