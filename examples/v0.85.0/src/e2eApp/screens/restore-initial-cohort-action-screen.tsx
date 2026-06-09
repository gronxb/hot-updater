import React from "react";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { ActionButtonScreen } from "./action-button-screen";

export const RestoreInitialCohortActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ActionButtonScreen
      current="RestoreInitialCohortAction"
      onPress={model.restoreInitialCohort}
      testID="action-restore-initial-cohort"
      title="Restore Cohort"
    />
  );
};
