import React from "react";

import { ActionButtonScreen } from "./action-button-screen";
import type { ScreenProps } from "./types";

export const SetCohortQaActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="SetCohortQaAction"
    onPress={model.setCohortToQa}
    testID="action-set-cohort-qa"
    title="Set qa"
  />
);
