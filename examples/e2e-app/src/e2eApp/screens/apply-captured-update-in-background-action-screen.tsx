import React from "react";

import { FocusedActionRoute } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const ApplyCapturedUpdateInBackgroundActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <FocusedActionRoute
      onFocus={model.applyCapturedUpdateInBackground}
      testID="action-apply-captured-update-in-background"
      title="Apply Captured In Background"
    />
  );
};
