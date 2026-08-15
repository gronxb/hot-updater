const ANDROID_NATIVE_RESTART_MESSAGE =
  "Started restart trampoline to apply update bundle";

export function hasNativeRestartEvidenceAfterMarker(
  logs: string,
  marker: string,
) {
  const markerIndex = logs.lastIndexOf(marker);
  return (
    markerIndex >= 0 &&
    logs.indexOf(ANDROID_NATIVE_RESTART_MESSAGE, markerIndex) > markerIndex
  );
}

export function advanceAndroidRestartWait(
  state: { clearedObservations: number },
  observation: {
    hasNativeRestartEvidence: boolean;
    hasTargetStaging: boolean;
    instrumentationActive: boolean;
  },
) {
  const countsAsCleared =
    observation.hasNativeRestartEvidence &&
    observation.hasTargetStaging &&
    !observation.instrumentationActive;

  return {
    clearedObservations: countsAsCleared ? state.clearedObservations + 1 : 0,
  };
}
