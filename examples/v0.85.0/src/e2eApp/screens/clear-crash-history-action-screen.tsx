import React from "react";

import { ActionButtonScreen } from "./action-button-screen";
import type { ScreenProps } from "./types";

export const ClearCrashHistoryActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="ClearCrashHistoryAction"
    onPress={model.clearCrashHistory}
    testID="action-clear-crash-history"
    title="Clear Crashes"
  />
);
