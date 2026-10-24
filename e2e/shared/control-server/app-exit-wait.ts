/**
 * What a `crash-after-content` bundle logs right before its fatal. The
 * deployed crash guard writes it; the exit wait reads it back.
 */
export const POST_CONTENT_CRASH_LOG_PREFIX = "HotUpdaterE2EPostContentCrash:";

export function postContentCrashLogLine(bundleId: string) {
  return `${POST_CONTENT_CRASH_LOG_PREFIX}${bundleId}`;
}

/**
 * Whether `logs` show `bundleId`'s post-content fatal after the current
 * launch's marker. Without a marker (a log stream started after the launch)
 * every line counts. Each crash launch of a scenario runs the same bundle, so
 * a line before the marker is an earlier launch's.
 */
export function hasPostContentCrashAfterMarker(
  logs: string,
  launchMarker: string | null,
  bundleId: string,
) {
  const start = launchMarker === null ? 0 : logs.lastIndexOf(launchMarker);
  if (start < 0) return false;
  return logs.indexOf(postContentCrashLogLine(bundleId), start) >= 0;
}

export type AppExitWaitState = {
  readonly crashLogged: boolean;
  readonly stoppedObservations: number;
};

export const initialAppExitWaitState: AppExitWaitState = {
  crashLogged: false,
  stoppedObservations: 0,
};

/**
 * One probe of the exit wait. A probe that finds the app running resets the
 * stopped count, so a process that restarts on its own is never taken for
 * an exit.
 */
export function advanceAppExitWait(
  state: AppExitWaitState,
  observation: { readonly crashLogged: boolean; readonly running: boolean },
): AppExitWaitState {
  return {
    crashLogged: state.crashLogged || observation.crashLogged,
    stoppedObservations: observation.running
      ? 0
      : state.stoppedObservations + 1,
  };
}

/**
 * The exit is proved only by both: the bundle's own fatal and a process that
 * stayed stopped. A stop without the fatal is a reload, a kill, or another
 * crash; the fatal without a stop leaves the app running.
 */
export function isAppExitProved(
  state: AppExitWaitState,
  requiredStoppedObservations: number,
) {
  return (
    state.crashLogged &&
    state.stoppedObservations >= requiredStoppedObservations
  );
}

export function describeAppExitWaitFailure(
  state: AppExitWaitState,
  bundleId: string,
) {
  if (state.crashLogged) {
    return `Bundle ${bundleId} logged its post-content crash, but the app did not stay stopped`;
  }
  return state.stoppedObservations > 0
    ? `The app stopped without bundle ${bundleId}'s post-content crash`
    : `Bundle ${bundleId} never reached its post-content crash, and the app kept running`;
}
