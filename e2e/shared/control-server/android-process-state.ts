/**
 * What Android's activity manager says of the app's process: its OOM
 * adjustment, where 900 and above is a cached process, and whether the
 * cached apps freezer froze it. Null fields are ones the dump did not show,
 * as for a process that is not running.
 */
export type AndroidProcessState = {
  readonly frozen: boolean | null;
  readonly oomAdj: number | null;
  readonly pendingFreeze: boolean | null;
};

/** Reads `adb shell dumpsys activity processes <package>`. */
export function parseAndroidProcessState(dump: string): AndroidProcessState {
  const flag = (name: string) => {
    const match = new RegExp(`\\b${name}=(true|false)\\b`).exec(dump);
    return match ? match[1] === "true" : null;
  };
  const adj = /\boom adj:[^\n]*\bcur=(-?\d+)/.exec(dump);
  return {
    frozen: flag("isFrozen"),
    oomAdj: adj ? Number(adj[1]) : null,
    pendingFreeze: flag("isPendingFreeze"),
  };
}
