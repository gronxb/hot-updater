import React from "react";

import { FocusedActionRoute, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const ApplyCohortInputActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <FocusedActionRoute
        onFocus={model.applyCohortInput}
        testID="action-apply-cohort-input"
        title="Apply Cohort"
      />
    </ScreenShell>
  );
};
