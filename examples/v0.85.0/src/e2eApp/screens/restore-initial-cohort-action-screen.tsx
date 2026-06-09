import React from "react";

import { ActionButtonScreen } from "./action-button-screen";
import type { ScreenProps } from "./types";

export const RestoreInitialCohortActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="RestoreInitialCohortAction"
    onPress={model.restoreInitialCohort}
    testID="action-restore-initial-cohort"
    title="Restore Cohort"
  />
);
