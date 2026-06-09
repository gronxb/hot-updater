import React from "react";

import { ActionButtonWithStartCount, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const SetCohortQaActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell>
      <ActionButtonWithStartCount
        onPress={model.setCohortToQa}
        testID="action-set-cohort-qa"
        title="Set QA"
      />
    </ScreenShell>
  );
};
