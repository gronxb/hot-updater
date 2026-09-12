import { HotUpdater } from "@hot-updater/lynx";

import {
  actionHandlers,
  handledScenarioAction,
  patchScreenState,
  scenarioMarker,
} from "./runtime-model";

const capturedUpdate: {
  current: Awaited<ReturnType<typeof HotUpdater.checkForUpdate>> | null;
} = { current: null };

let cohortInput = "1";
let runtimeChannelInput = "beta";

const setUpdateActionResult = async (result: string) => {
  await patchScreenState({ updateActionResult: result });
};
const setChannelActionResult = async (result: string) => {
  await patchScreenState({ channelActionResult: result });
};
const setCohortActionResult = async (result: string) => {
  await patchScreenState({ cohortActionResult: result });
};

const installUpdate = async ({
  actionLabel,
  channel,
  strategy = "appVersion",
}: {
  actionLabel: string;
  channel?: string;
  strategy?: "appVersion" | "fingerprint";
}) => {
  await setUpdateActionResult(`${actionLabel} -> checking`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const updateInfo = await HotUpdater.checkForUpdate({
        updateStrategy: strategy,
        ...(channel ? { channel } : {}),
      });
      if (!updateInfo) {
        await setUpdateActionResult(`${actionLabel} -> no-update`);
        return;
      }
      const installed = await updateInfo.updateBundle();
      const appliedResult =
        updateInfo.transitionKind === "ADOPT_RELEASE"
          ? `${actionLabel} -> adopted ID ${updateInfo.id}`
          : updateInfo.transitionKind === "USE_EMBEDDED"
            ? `${actionLabel} -> selected EMBEDDED ID ${updateInfo.id}`
            : updateInfo.transitionKind === "USE_BUILTIN"
              ? `${actionLabel} -> selected BUILTIN`
              : `${actionLabel} -> installed ID ${updateInfo.id}`;
      let stagingBundleId: string | null = updateInfo.id;
      let stagingReleaseId: string | null = updateInfo.releaseId ?? null;
      let stableBundleId: string | null = null;
      let verificationPending: boolean | null = installed;
      try {
        const active = HotUpdater.getActiveUpdateState();
        stagingBundleId = active.activeSelection?.bundleId ?? stagingBundleId;
        stagingReleaseId =
          active.activeSelection?.releaseId ?? stagingReleaseId;
        stableBundleId = active.stableSelection?.bundleId ?? null;
        verificationPending = active.verificationPending;
      } catch {
        // Native snapshot may not be readable until notifyAppReady.
      }
      await patchScreenState({
        stagingBundleId,
        stagingReleaseId,
        stableBundleId,
        verificationPending,
      });
      await setUpdateActionResult(
        installed ? appliedResult : `${actionLabel} -> skipped`,
      );
      return;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to install update";
      const stale =
        message.includes("Native revision changed") ||
        message.includes("STALE_STATE") ||
        message.includes("STALE_SELECTION");
      if (stale && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      await setUpdateActionResult(`${actionLabel} -> error ${message}`);
      return;
    }
  }
};

const applyCohortValue = async (nextCohort: string) => {
  await Promise.resolve(HotUpdater.setCohort(nextCohort));
  const applied = HotUpdater.getCohort();
  cohortInput = applied;
  await patchScreenState({ cohortInput: applied });
  await setCohortActionResult(`set -> ${applied}`);
};

export function bindStandaloneE2eActionHandlers(): void {
  const actions: Record<string, (text?: string) => Promise<void>> = {
    "action-install-current-channel-update": () =>
      installUpdate({ actionLabel: "current-channel" }),
    "action-install-fingerprint-update": () =>
      installUpdate({ actionLabel: "fingerprint", strategy: "fingerprint" }),
    "action-install-runtime-channel-update": async () => {
      const normalizedChannel = runtimeChannelInput.trim().toLowerCase();
      if (!normalizedChannel) {
        await setChannelActionResult("runtime-channel -> invalid");
        return;
      }
      await setChannelActionResult(`runtime-channel -> ${normalizedChannel}`);
      await installUpdate({
        actionLabel: `runtime-channel:${normalizedChannel}`,
        channel: normalizedChannel,
      });
    },
    "action-reset-runtime-channel": async () => {
      const didReset = await HotUpdater.resetChannel();
      await setChannelActionResult(`reset -> ${String(didReset)}`);
    },
    "action-apply-cohort-input": () =>
      applyCohortValue(HotUpdater.getCohort() || cohortInput),
    "action-set-cohort-qa": () => applyCohortValue("qa"),
    "action-restore-initial-cohort": async () => {
      await applyCohortValue("1");
      await setCohortActionResult(`restore -> ${HotUpdater.getCohort()}`);
    },
    "action-clear-crash-history": async () => {
      HotUpdater.clearCrashHistory();
    },
    "action-reload-app": async () => {
      await HotUpdater.reload();
    },
    "action-refresh-runtime-snapshot": async () => {
      await HotUpdater.notifyAppReady();
    },
    "action-capture-current-channel-update": async () => {
      const updateInfo = await HotUpdater.checkForUpdate({
        updateStrategy: "appVersion",
      });
      capturedUpdate.current = updateInfo;
      await setUpdateActionResult(
        updateInfo
          ? `captured-update -> Release ${updateInfo.releaseId ?? "legacy"}`
          : "captured-update -> no-update",
      );
    },
    "action-apply-captured-update": async () => {
      const updateInfo = capturedUpdate.current;
      if (!updateInfo) {
        await setUpdateActionResult("captured-update -> missing");
        return;
      }
      const installed = await updateInfo.updateBundle();
      await setUpdateActionResult(
        installed
          ? `captured-update -> installed Release ${updateInfo.releaseId ?? "legacy"}`
          : "captured-update -> skipped",
      );
    },
    "cohort-input": async (text) => {
      if (text === undefined) return;
      await Promise.resolve(HotUpdater.setCohort(text));
      cohortInput = text;
      await patchScreenState({ cohortInput: text });
    },
    "runtime-channel-input": async (text) => {
      if (text === undefined) return;
      runtimeChannelInput = text;
      await patchScreenState({ runtimeChannelInput: text });
    },
  };
  actionHandlers.current = actions;
}

export async function publishOverlayReady(): Promise<void> {
  await patchScreenState({ runtimeScenarioMarker: scenarioMarker });
}

export async function bootNotifyAppReady(): Promise<void> {
  try {
    const result = await HotUpdater.notifyAppReady();
    await patchScreenState({
      runtimeScenarioMarker: scenarioMarker,
      launchStatus: `Current Launch Status: ${result.status}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchScreenState({
      runtimeScenarioMarker: scenarioMarker,
      launchStatus: `Current Launch Status: ERROR ${message}`,
    });
  }
}

export function scheduleForceUpdateReload(): void {
  setTimeout(() => {
    void (async () => {
      if (handledScenarioAction) return;
      try {
        const updateInfo = await HotUpdater.checkForUpdate({
          updateStrategy: "appVersion",
        });
        if (handledScenarioAction || !updateInfo?.shouldForceUpdate) {
          return;
        }
        const runningId = HotUpdater.getBundleId();
        if (updateInfo.id === runningId || updateInfo.bundleId === runningId) {
          return;
        }
        if (await updateInfo.updateBundle()) await HotUpdater.reload();
      } catch {
        // Overlay launch continues; metadata wait observes the native result.
      }
    })();
  }, 300);
}
