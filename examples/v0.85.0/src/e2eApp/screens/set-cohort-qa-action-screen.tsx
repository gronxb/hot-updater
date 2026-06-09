import React from "react";

import { Button, ScreenShell } from "../components";
import { useE2eRuntimeModelContext } from "../runtime-model-context";

export const SetCohortQaActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ScreenShell current="SetCohortQaAction">
      <Button
        onPress={model.setCohortToQa}
        testID="action-set-cohort-qa"
        title="Set QA"
      />
    </ScreenShell>
  );
};
