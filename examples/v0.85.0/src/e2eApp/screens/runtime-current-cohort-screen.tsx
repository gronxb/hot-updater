import React from "react";

import { ScreenShell, ValueText } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeCurrentCohortScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <ValueText
        testID="runtime-current-cohort"
        value={model.runtimeSnapshot.cohort}
      />
    </ScreenShell>
  );
};
