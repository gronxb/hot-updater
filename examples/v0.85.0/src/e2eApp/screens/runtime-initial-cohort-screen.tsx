import React from "react";

import { InfoRow, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RuntimeInitialCohortScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <InfoRow
        label="Initial Cohort"
        value={model.initialCohort}
        valueTestID="runtime-initial-cohort"
      />
    </ScreenShell>
  );
};
