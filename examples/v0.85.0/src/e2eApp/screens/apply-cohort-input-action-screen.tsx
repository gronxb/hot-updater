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
