import type {
  CheckForUpdateOptions,
  CheckForUpdateResult,
  HotUpdater,
  NotifyAppReadyResult,
} from "@hot-updater/lynx";

type RuntimeClient = Pick<
  typeof HotUpdater,
  | "getLaunchInfo"
  | "getActiveUpdateState"
  | "getChannel"
  | "getDefaultChannel"
  | "isChannelSwitched"
  | "getCohort"
  | "getCrashHistory"
>;

export async function readRuntimeSnapshot(client: RuntimeClient) {
  const launch = await client.getLaunchInfo();
  const active = client.getActiveUpdateState();
  const nextDiffersFromRunning =
    launch.next !== null &&
    (launch.next.kind !== launch.running.kind ||
      launch.next.bundleId !== launch.running.bundleId ||
      launch.next.releaseId !== launch.running.releaseId ||
      launch.next.channel !== launch.running.channel);
  return {
    currentBundleId: launch.running.bundleId,
    currentReleaseId: launch.running.releaseId,
    currentCohort: client.getCohort(),
    crashHistoryCount: String(client.getCrashHistory().length),
    currentChannel: client.getChannel(),
    defaultChannel: client.getDefaultChannel(),
    channelSwitched: String(client.isChannelSwitched()),
    stagingBundleId: launch.next?.bundleId ?? null,
    stagingReleaseId: launch.next?.releaseId ?? null,
    stableBundleId: active.stableSelection?.bundleId ?? null,
    stableReleaseId: active.stableSelection?.releaseId ?? null,
    verificationPending: !launch.confirmed || nextDiffersFromRunning,
  };
}

export type RuntimeSnapshot = Awaited<ReturnType<typeof readRuntimeSnapshot>>;

export async function confirmRuntimeReady(
  client: Pick<typeof HotUpdater, "notifyAppReady">,
  publish: (status: string) => Promise<void>,
): Promise<NotifyAppReadyResult> {
  const result = await client.notifyAppReady();
  await publish(`Current Launch Status: ${result.status}`);
  return result;
}

export async function installCheckedUpdate(
  client: Pick<typeof HotUpdater, "checkForUpdate">,
  options: CheckForUpdateOptions,
  actionLabel: string,
) {
  const update = await client.checkForUpdate(options);
  if (!update) return `${actionLabel} -> no-update`;
  if (!(await update.updateBundle())) return `${actionLabel} -> skipped`;
  return formatInstalledUpdate(update, actionLabel);
}

function formatInstalledUpdate(update: CheckForUpdateResult, label: string) {
  switch (update.transitionKind) {
    case "ADOPT_RELEASE":
      return `${label} -> adopted ID ${update.id}`;
    case "USE_EMBEDDED":
      return `${label} -> selected EMBEDDED ID ${update.id}`;
    case "USE_BUILTIN":
      return `${label} -> selected BUILTIN`;
    default:
      return `${label} -> installed ID ${update.id}`;
  }
}

export async function applyForcedUpdate(
  client: Pick<
    typeof HotUpdater,
    "checkForUpdate" | "getLaunchInfo" | "reload"
  >,
  shouldStop: () => boolean,
) {
  if (shouldStop()) return;
  const update = await client.checkForUpdate({
    updateStrategy: "appVersion",
    requestTimeout: 5000,
  });
  if (shouldStop() || !update?.shouldForceUpdate) return;
  const { running } = await client.getLaunchInfo();
  if (
    running.bundleId === update.bundleId &&
    running.releaseId === update.releaseId
  ) {
    return;
  }
  if (!(await update.updateBundle())) return;
  await client.reload();
}
