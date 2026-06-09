import React from "react";

import { Button, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const ApplyCohortInputActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <Button
        onPress={model.applyCohortInput}
        testID="action-apply-cohort-input"
        title="Apply Cohort"
      />
    </ScreenShell>
  );
};
