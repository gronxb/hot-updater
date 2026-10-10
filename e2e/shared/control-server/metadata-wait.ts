export function resolveMetadataWaitReleaseId(
  bundleId: string,
  releaseId: string | null | undefined,
  deployments: ReadonlyArray<{ bundleId: string; releaseId: string }>,
): string | null | undefined {
  return releaseId === undefined
    ? deployments.findLast((record) => record.bundleId === bundleId)?.releaseId
    : releaseId;
}

export function isExpectedMetadataStateReached(
  metadataState: {
    stableBundleId: string | null;
    stagingBundleId: string | null;
    verificationPending: boolean | null;
    stagingSelection: { releaseId: string | null } | null;
  },
  bundleId: string,
  verificationPending: boolean,
  releaseId: string | null | undefined,
  isLynx: boolean,
) {
  if (metadataState.stagingBundleId !== bundleId) {
    return false;
  }

  if (
    releaseId !== undefined &&
    metadataState.stagingSelection?.releaseId !== releaseId
  ) {
    return false;
  }

  if (metadataState.verificationPending === verificationPending) {
    return true;
  }

  return (
    !isLynx &&
    verificationPending &&
    metadataState.verificationPending === false
  );
}
