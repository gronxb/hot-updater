import {
  assertInitProviderInputs,
  resolveInitProviderInput,
} from "@hot-updater/cli-tools";

import { initProvider as FIREBASE_INIT_PROVIDER } from "./init/index";

export type FirebaseInitInputs = {
  readonly applicationCredentials?: string;
  readonly projectId?: string;
  readonly region?: string;
};

export type FirebaseCliEnv = Readonly<Record<string, string>>;

export const getFirebaseCliEnv = (
  applicationCredentials?: string,
): FirebaseCliEnv | undefined =>
  applicationCredentials
    ? {
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: applicationCredentials,
        [FIREBASE_INIT_PROVIDER.inputs.applicationCredentials.envKey]:
          applicationCredentials,
      }
    : undefined;

export const resolveFirebaseInitInputs = (
  existingEnv: Record<string, string>,
): FirebaseInitInputs => {
  const { inputs } = FIREBASE_INIT_PROVIDER;
  const applicationCredentials = resolveInitProviderInput(
    existingEnv,
    inputs.applicationCredentials,
  );
  return {
    applicationCredentials:
      applicationCredentials === "your-credentials.json"
        ? undefined
        : applicationCredentials,
    projectId: resolveInitProviderInput(existingEnv, inputs.projectId),
    region: resolveInitProviderInput(existingEnv, inputs.region),
  };
};

export const assertFirebaseNonInteractiveInputs = (
  inputs: FirebaseInitInputs,
  nonInteractive = false,
): void => {
  assertInitProviderInputs({
    inputs,
    provider: FIREBASE_INIT_PROVIDER,
    strict: nonInteractive,
  });
};
