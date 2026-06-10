import React from "react";

import { PressInActionButton, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RestoreInitialCohortActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <PressInActionButton
        onPress={model.restoreInitialCohort}
        testID="action-restore-initial-cohort"
        title="Restore Cohort"
      />
    </ScreenShell>
  );
};
