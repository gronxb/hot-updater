import React from "react";

import { PressInActionButton, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const SetCohortQaActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <PressInActionButton
        onPress={model.setCohortToQa}
        testID="action-set-cohort-qa"
        title="Set QA"
      />
    </ScreenShell>
  );
};
