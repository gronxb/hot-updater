import React from "react";

import { ActionButtonScreen } from "./action-button-screen";
import type { ScreenProps } from "./types";

export const ApplyCohortInputActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="ApplyCohortInputAction"
    onPress={model.applyCohortInput}
    testID="action-apply-cohort-input"
    title="Apply Cohort"
  />
);

export const SetCohortQaActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="SetCohortQaAction"
    onPress={model.setCohortToQa}
    testID="action-set-cohort-qa"
    title="Set qa"
  />
);

export const RestoreInitialCohortActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="RestoreInitialCohortAction"
    onPress={model.restoreInitialCohort}
    testID="action-restore-initial-cohort"
    title="Restore Cohort"
  />
);
