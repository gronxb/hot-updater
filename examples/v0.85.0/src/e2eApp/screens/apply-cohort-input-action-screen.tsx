import React from "react";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { ActionButtonScreen } from "./action-button-screen";

export const ApplyCohortInputActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ActionButtonScreen
      current="ApplyCohortInputAction"
      onPress={model.applyCohortInput}
      testID="action-apply-cohort-input"
      title="Apply Cohort"
    />
  );
};
