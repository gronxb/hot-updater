import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  INVALID_COHORT_ERROR_MESSAGE,
  isValidCohort,
  type Bundle,
} from "@hot-updater/core";

const normalizeNullableString = (value: string | null | undefined) => {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

export const assertBundlePersistenceConstraints = (
  bundle: Pick<
    Bundle,
    | "fingerprintHash"
    | "rolloutCohortCount"
    | "targetAppVersion"
    | "targetCohorts"
  >,
) => {
  const targetAppVersion = normalizeNullableString(bundle.targetAppVersion);
  const fingerprintHash = normalizeNullableString(bundle.fingerprintHash);

  if (!targetAppVersion && !fingerprintHash) {
    throw new Error(
      "Bundle must define either targetAppVersion or fingerprintHash.",
    );
  }

  const rolloutCohortCount = bundle.rolloutCohortCount;
  if (rolloutCohortCount !== null && rolloutCohortCount !== undefined) {
    if (
      !Number.isInteger(rolloutCohortCount) ||
      rolloutCohortCount < 0 ||
      rolloutCohortCount > DEFAULT_ROLLOUT_COHORT_COUNT
    ) {
      throw new Error(
        `rolloutCohortCount must be an integer between 0 and ${DEFAULT_ROLLOUT_COHORT_COUNT}.`,
      );
    }
  }

  for (const cohort of bundle.targetCohorts ?? []) {
    if (!isValidCohort(cohort)) {
      throw new Error(
        `Invalid target cohort "${cohort}". ${INVALID_COHORT_ERROR_MESSAGE}`,
      );
    }
  }
};
