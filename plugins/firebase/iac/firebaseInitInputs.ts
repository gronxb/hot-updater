import {
  assertInitInputs,
  getHotUpdaterEnvValue,
} from "@hot-updater/cli-tools";

export type FirebaseInitInputs = {
  readonly projectId?: string;
  readonly region?: string;
};

export const resolveFirebaseInitInputs = (
  existingEnv: Record<string, string>,
): FirebaseInitInputs => ({
  projectId: getHotUpdaterEnvValue(
    existingEnv,
    "HOT_UPDATER_FIREBASE_PROJECT_ID",
  ),
  region: getHotUpdaterEnvValue(existingEnv, "HOT_UPDATER_FIREBASE_REGION"),
});

export const assertFirebaseNonInteractiveInputs = (
  inputs: FirebaseInitInputs,
  nonInteractive = false,
): void => {
  assertInitInputs({
    inputs: {
      HOT_UPDATER_FIREBASE_PROJECT_ID: inputs.projectId,
      HOT_UPDATER_FIREBASE_REGION: inputs.region,
    },
    strict: nonInteractive,
  });
};
