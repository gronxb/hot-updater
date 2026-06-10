import React from "react";

import { PressInActionButton, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const ApplyCohortInputActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <PressInActionButton
        onPress={model.applyCohortInput}
        testID="action-apply-cohort-input"
        title="Apply Cohort"
      />
    </ScreenShell>
  );
};
