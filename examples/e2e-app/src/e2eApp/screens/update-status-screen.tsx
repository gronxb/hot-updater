import React, { useEffect, useState } from "react";

import { ValueText } from "../components";
import { hotUpdater } from "../runtime";

// What a diagnostics screen shows about this build. Every deep link opens the
// screen again, so each one reads fresh values.
export const UpdateStatusScreen = () => {
  const [value, setValue] = useState("loading");

  useEffect(() => {
    let active = true;
    void hotUpdater.getUpdateStatus().then((status) => {
      if (!active) return;
      setValue(
        [
          `isEnabled=${status.isEnabled}`,
          `disabledReason=${status.disabledReason ?? "none"}`,
          `isUpdatePending=${status.isUpdatePending}`,
          `pendingBundleId=${status.pendingBundleId ?? "none"}`,
          `bundleId=${status.bundleId}`,
          `channel=${status.channel}`,
        ].join("\n"),
      );
    });
    return () => {
      active = false;
    };
  }, []);

  return <ValueText testID="update-status-result" value={value} />;
};
