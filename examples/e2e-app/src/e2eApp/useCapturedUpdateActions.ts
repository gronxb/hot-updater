import { useRef } from "react";
import { AppState } from "react-native";

import { hotUpdater } from "./runtime";

/** A captured update's target: a Release, or the built-in bundle. */
const describeTarget = (releaseId: string | null | undefined) =>
  releaseId ? `Release ${releaseId}` : "built-in bundle";

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
          ? `captured-update -> ${describeTarget(updateInfo.releaseId)}`
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
          ? `captured-update -> installed ${describeTarget(updateInfo.releaseId)}`
          : "captured-update -> skipped",
      );
      await refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to apply update";
      await setUpdateActionResult(`captured-update -> error ${message}`);
    }
  };

  // Applies the captured update once the app leaves the foreground, so the
  // download starts while iOS reports the app inactive or in the background.
  const applyCapturedUpdateInBackground = async () => {
    if (!capturedUpdateRef.current) {
      await setUpdateActionResult("captured-update -> missing");
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      subscription.remove();
      void applyCapturedUpdate();
    });
    await setUpdateActionResult("captured-update -> waiting for background");
  };

  return {
    applyCapturedUpdate,
    applyCapturedUpdateInBackground,
    captureCurrentChannelUpdate,
  };
};
