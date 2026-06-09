import React from "react";

import { InfoRow, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeCurrentCohortScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <InfoRow
        label="Current Cohort"
        value={model.runtimeSnapshot.cohort}
        valueTestID="runtime-current-cohort"
      />
    </ScreenShell>
  );
};
