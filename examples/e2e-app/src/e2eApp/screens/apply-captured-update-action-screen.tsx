import React from "react";

import { FocusedActionRoute } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const ApplyCapturedUpdateActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <FocusedActionRoute
      onFocus={model.applyCapturedUpdate}
      testID="action-apply-captured-update"
      title="Apply Captured"
    />
  );
};
