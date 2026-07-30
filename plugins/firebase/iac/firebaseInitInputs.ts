import os from "node:os";
import path from "node:path";

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

type FirebaseCredentialsPathContext = {
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly pathApi?: Pick<typeof path, "resolve">;
};

const resolveFirebaseCredentialsPath = (
  credentialsPath: string,
  {
    cwd = process.cwd(),
    homeDir = os.homedir(),
    pathApi = path,
  }: FirebaseCredentialsPathContext,
) => {
  const homeRelativePath =
    credentialsPath === "~"
      ? ""
      : credentialsPath.startsWith("~/") || credentialsPath.startsWith("~\\")
        ? credentialsPath.slice(2)
        : undefined;

  return homeRelativePath === undefined
    ? pathApi.resolve(cwd, credentialsPath)
    : pathApi.resolve(homeDir, homeRelativePath);
};

export const getFirebaseCliEnv = (
  applicationCredentials?: string,
  pathContext: FirebaseCredentialsPathContext = {},
): FirebaseCliEnv | undefined => {
  if (!applicationCredentials) {
    return undefined;
  }

  const resolvedCredentialsPath = resolveFirebaseCredentialsPath(
    applicationCredentials,
    pathContext,
  );
  return {
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: resolvedCredentialsPath,
    [FIREBASE_INIT_PROVIDER.inputs.applicationCredentials.envKey]:
      resolvedCredentialsPath,
  };
};

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
