function hashUserId(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }

  return Math.abs(hash % 100);
}

export function isDeviceEligibleForUpdate(
  deviceId: string,
  rolloutPercentage: number | null | undefined,
  targetDeviceIds: readonly string[] | null | undefined,
): boolean {
  if (targetDeviceIds && targetDeviceIds.length > 0) {
    return targetDeviceIds.includes(deviceId);
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

  const deviceHash = hashUserId(deviceId);
  return deviceHash < rolloutPercentage;
}
