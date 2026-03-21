export const NUMERIC_COHORT_SIZE = 1000;
export const DEFAULT_ROLLOUT_COHORT_COUNT = NUMERIC_COHORT_SIZE;

const CUSTOM_COHORT_PATTERN = /^[a-z0-9-]+$/;

function parseNumericCohortValue(cohort: string): number | null {
  if (!/^\d+$/.test(cohort)) {
    return null;
  }

  const parsed = Number.parseInt(cohort, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > NUMERIC_COHORT_SIZE) {
    return null;
  }

  return parsed;
}

function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }

  return hash;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);

  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }

  return x;
}

function modularInverse(value: number, modulus: number): number {
  let t = 0;
  let newT = 1;
  let r = modulus;
  let newR = positiveMod(value, modulus);

  while (newR !== 0) {
    const quotient = Math.floor(r / newR);
    [t, newT] = [newT, t - quotient * newT];
    [r, newR] = [newR, r - quotient * newR];
  }

  if (r > 1) {
    throw new Error(`No modular inverse for ${value} mod ${modulus}`);
  }

  return positiveMod(t, modulus);
}

function getRolloutShuffleParameters(bundleId: string) {
  let multiplier = positiveMod(hashString(`${bundleId}:multiplier`), 997);

  if (multiplier === 0) {
    multiplier = 1;
  }

  while (gcd(multiplier, NUMERIC_COHORT_SIZE) !== 1) {
    multiplier = positiveMod(multiplier + 1, NUMERIC_COHORT_SIZE);
    if (multiplier === 0) {
      multiplier = 1;
    }
  }

  const offset = positiveMod(
    hashString(`${bundleId}:offset`),
    NUMERIC_COHORT_SIZE,
  );

  return {
    multiplier,
    offset,
    inverseMultiplier: modularInverse(multiplier, NUMERIC_COHORT_SIZE),
  };
}

export function normalizeRolloutCohortCount(
  rolloutCohortCount: number | null | undefined,
): number {
  if (rolloutCohortCount === null || rolloutCohortCount === undefined) {
    return DEFAULT_ROLLOUT_COHORT_COUNT;
  }

  if (rolloutCohortCount <= 0) {
    return 0;
  }

  if (rolloutCohortCount >= NUMERIC_COHORT_SIZE) {
    return NUMERIC_COHORT_SIZE;
  }

  return Math.floor(rolloutCohortCount);
}

export function normalizeCohortValue(cohort: string): string {
  const normalized = cohort.trim().toLowerCase();
  const numericCohort = parseNumericCohortValue(normalized);

  if (numericCohort !== null) {
    return String(numericCohort);
  }

  return normalized;
}

export function getNumericCohortValue(cohort: string): number | null {
  return parseNumericCohortValue(normalizeCohortValue(cohort));
}

export function isNumericCohort(cohort: string): boolean {
  return getNumericCohortValue(cohort) !== null;
}

export function isCustomCohort(cohort: string): boolean {
  return (
    CUSTOM_COHORT_PATTERN.test(cohort) && getNumericCohortValue(cohort) === null
  );
}

export function isValidCohort(cohort: string): boolean {
  const normalized = normalizeCohortValue(cohort);
  return isNumericCohort(normalized) || isCustomCohort(normalized);
}

export function getDefaultNumericCohort(identifier: string): string {
  const cohortValue =
    positiveMod(hashString(identifier), NUMERIC_COHORT_SIZE) + 1;
  return String(cohortValue);
}

export function getNumericCohortRolloutPosition(
  bundleId: string,
  cohortValue: number,
): number {
  if (cohortValue < 1 || cohortValue > NUMERIC_COHORT_SIZE) {
    throw new Error(`Invalid numeric cohort: ${cohortValue}`);
  }

  const { offset, inverseMultiplier } = getRolloutShuffleParameters(bundleId);
  const zeroBasedCohort = cohortValue - 1;

  return positiveMod(
    inverseMultiplier * (zeroBasedCohort - offset),
    NUMERIC_COHORT_SIZE,
  );
}

export function isCohortEligibleForUpdate(
  bundleId: string,
  cohort: string | null | undefined,
  rolloutCohortCount: number | null | undefined,
  targetCohorts: readonly string[] | null | undefined,
): boolean {
  const normalizedCohort =
    cohort === null || cohort === undefined
      ? undefined
      : normalizeCohortValue(cohort);
  const normalizedTargetCohorts =
    targetCohorts?.map((targetCohort) => normalizeCohortValue(targetCohort)) ??
    [];

  if (normalizedTargetCohorts.length > 0) {
    return (
      normalizedCohort !== undefined &&
      normalizedTargetCohorts.includes(normalizedCohort)
    );
  }

  const normalizedRolloutCount =
    normalizeRolloutCohortCount(rolloutCohortCount);

  if (normalizedRolloutCount <= 0) {
    return false;
  }

  if (normalizedCohort === undefined) {
    return normalizedRolloutCount >= NUMERIC_COHORT_SIZE;
  }

  const numericCohort = getNumericCohortValue(normalizedCohort);
  if (numericCohort === null) {
    return false;
  }

  if (normalizedRolloutCount >= NUMERIC_COHORT_SIZE) {
    return true;
  }

  return (
    getNumericCohortRolloutPosition(bundleId, numericCohort) <
    normalizedRolloutCount
  );
}
