import React, { useEffect, useState } from "react";

import { ValueText } from "../components";
import { hotUpdater } from "../runtime";

const LOADING = "loading";

// What an in-app diagnostics screen shows: this build's update state, and the
// log of what happened to its updates. Every deep link opens the screen again,
// so each one reads fresh values.
export const UpdateDiagnosticsScreen = () => {
  const [status, setStatus] = useState(LOADING);
  const [logs, setLogs] = useState(LOADING);

  useEffect(() => {
    let active = true;
    void Promise.all([
      hotUpdater.getUpdateStatus(),
      hotUpdater.getUpdateLogs({ limit: 50 }),
    ]).then(([nextStatus, nextLogs]) => {
      if (!active) return;
      setStatus(
        [
          `isEnabled=${nextStatus.isEnabled}`,
          `disabledReason=${nextStatus.disabledReason ?? "none"}`,
          `isUpdatePending=${nextStatus.isUpdatePending}`,
          `pendingBundleId=${nextStatus.pendingBundleId ?? "none"}`,
          `bundleId=${nextStatus.bundleId}`,
          `channel=${nextStatus.channel}`,
        ].join("\n"),
      );
      setLogs(
        nextLogs === null
          ? "unavailable"
          : nextLogs
              .map(({ type, outcome, bundleId, channel, error }) =>
                [
                  type,
                  outcome,
                  bundleId ?? "-",
                  channel ?? "-",
                  error?.code ?? error?.message ?? "",
                ]
                  .join(" ")
                  .trim(),
              )
              .join("\n") || "none",
      );
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <ValueText testID="update-status-result" value={status} />
      <ValueText testID="update-logs-result" value={logs} />
    </>
  );
};
