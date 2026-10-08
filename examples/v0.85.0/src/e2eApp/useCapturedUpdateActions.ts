import { useRef } from "react";

import { hotUpdater } from "./runtime";

export const useCapturedUpdateActions = ({
  refresh,
  setUpdateActionResult,
}: {
  readonly refresh: () => Promise<void>;
  readonly setUpdateActionResult: (result: string) => Promise<void>;
}) => {
  const capturedUpdateRef =
    useRef<Awaited<ReturnType<typeof hotUpdater.checkForUpdate>>>(null);

  const captureCurrentChannelUpdate = async () => {
    try {
      const updateInfo = await hotUpdater.checkForUpdate({
        updateStrategy: "appVersion",
      });
      capturedUpdateRef.current = updateInfo;
      await setUpdateActionResult(
        updateInfo
          ? `captured-update -> Release ${updateInfo.releaseId ?? "legacy"}`
          : "captured-update -> no-update",
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to capture update";
      await setUpdateActionResult(`captured-update -> error ${message}`);
    }
  };

  const applyCapturedUpdate = async () => {
    const updateInfo = capturedUpdateRef.current;
    if (!updateInfo) {
      await setUpdateActionResult("captured-update -> missing");
      return;
    }
    try {
      const installed = await updateInfo.updateBundle();
      await setUpdateActionResult(
        installed
          ? `captured-update -> installed Release ${updateInfo.releaseId ?? "legacy"}`
          : "captured-update -> skipped",
      );
      await refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to apply update";
      await setUpdateActionResult(`captured-update -> error ${message}`);
    }
  };

  return { applyCapturedUpdate, captureCurrentChannelUpdate };
};
