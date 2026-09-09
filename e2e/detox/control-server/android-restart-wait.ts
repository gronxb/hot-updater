const ANDROID_NATIVE_RESTART_MESSAGE =
  "Started restart trampoline to apply update bundle";
const ANDROID_WATCHDOG_RESTART_MESSAGE =
  "Recovery watchdog detected crash marker, relaunching app";

export function hasNativeRestartEvidenceAfterMarker(
  logs: string,
  marker: string,
) {
  const markerIndex = logs.lastIndexOf(marker);
  return (
    markerIndex >= 0 &&
    (logs.indexOf(ANDROID_NATIVE_RESTART_MESSAGE, markerIndex) > markerIndex ||
      logs.indexOf(ANDROID_WATCHDOG_RESTART_MESSAGE, markerIndex) > markerIndex)
  );
}

export function isAndroidRecoveryProcessReady(observation: {
  appId: string;
  focusedPackage: string | null;
  hasNativeRestartEvidence: boolean;
  instrumentationActive: boolean;
  processId: string;
}) {
  return (
    observation.hasNativeRestartEvidence &&
    observation.processId.trim().length > 0 &&
    observation.focusedPackage === observation.appId &&
    !observation.instrumentationActive
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
