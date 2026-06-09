import React from "react";

import { ActionButtonWithStartCount, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const ApplyCohortInputActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <ActionButtonWithStartCount
        onPress={model.applyCohortInput}
        testID="action-apply-cohort-input"
        title="Apply Cohort"
      />
    </ScreenShell>
  );
};
