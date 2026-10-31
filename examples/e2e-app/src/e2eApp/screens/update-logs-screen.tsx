import React, { useEffect, useState } from "react";

import { ValueText } from "../components";
import { hotUpdater } from "../runtime";

// What a diagnostics screen lists about this device's updates. Every deep link
// opens the screen again, so each one reads fresh entries.
export const UpdateLogsScreen = () => {
  const [value, setValue] = useState("loading");

  useEffect(() => {
    let active = true;
    void hotUpdater.getUpdateLogs({ limit: 50 }).then((logs) => {
      if (!active) return;
      setValue(
        logs === null
          ? "unavailable"
          : logs
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

  return <ValueText testID="update-logs-result" value={value} />;
};
