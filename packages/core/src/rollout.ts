function hashUserId(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash % 100);
}

/**
 * Determines if a device is eligible for an update based on rollout settings.
 * Priority: targetDeviceIds > percentage-based rollout
 */
export function isDeviceEligibleForUpdate(
  userId: string,
  rolloutPercentage: number | null | undefined,
  targetDeviceIds: string[] | null | undefined,
): boolean {
  if (targetDeviceIds && targetDeviceIds.length > 0) {
    return targetDeviceIds.includes(userId);
  }

  if (
    rolloutPercentage === null ||
    rolloutPercentage === undefined ||
    rolloutPercentage >= 100
  ) {
    return true;
  }

  if (rolloutPercentage <= 0) {
    return false;
  }

  const userHash = hashUserId(userId);
  return userHash < rolloutPercentage;
}
