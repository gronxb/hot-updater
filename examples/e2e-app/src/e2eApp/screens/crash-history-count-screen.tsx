import React from "react";

import { ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const CrashHistoryCountScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ValueText
      testID="crash-history-count"
      value={String(model.runtimeSnapshot.crashHistory.length)}
    />
  );
};
