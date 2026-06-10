import React from "react";

import { ScreenShell, ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const CrashHistoryCountScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <ValueText
        testID="crash-history-count"
        value={String(model.runtimeSnapshot.crashHistory.length)}
      />
    </ScreenShell>
  );
};
