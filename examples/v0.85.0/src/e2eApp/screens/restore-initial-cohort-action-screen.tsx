import React from "react";

import { FocusedActionRoute } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const RestoreInitialCohortActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <FocusedActionRoute
      onFocus={model.restoreInitialCohort}
      testID="action-restore-initial-cohort"
      title="Restore Cohort"
    />
  );
};
