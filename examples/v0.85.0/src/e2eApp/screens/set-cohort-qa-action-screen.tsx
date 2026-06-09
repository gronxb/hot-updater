import React from "react";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { ActionButtonScreen } from "./action-button-screen";

export const SetCohortQaActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ActionButtonScreen
      current="SetCohortQaAction"
      onPress={model.setCohortToQa}
      testID="action-set-cohort-qa"
      title="Set qa"
    />
  );
};
