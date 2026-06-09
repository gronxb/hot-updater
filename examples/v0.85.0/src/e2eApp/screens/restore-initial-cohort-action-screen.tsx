import React from "react";

import { Button, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RestoreInitialCohortActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <Button
        onPress={model.restoreInitialCohort}
        testID="action-restore-initial-cohort"
        title="Restore Cohort"
      />
    </ScreenShell>
  );
};
