import React from "react";

import { InfoRow, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const CrashHistoryCountScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <InfoRow
        label="Crash History Count"
        value={String(model.runtimeSnapshot.crashHistory.length)}
        valueTestID="crash-history-count"
      />
    </ScreenShell>
  );
};
