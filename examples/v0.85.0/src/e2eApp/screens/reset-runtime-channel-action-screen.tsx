import React from "react";

import { ActionButtonScreen } from "./action-button-screen";
import type { ScreenProps } from "./types";

export const ResetRuntimeChannelActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="ResetRuntimeChannelAction"
    onPress={model.resetRuntimeChannel}
    testID="action-reset-runtime-channel"
    title="Reset Channel"
  />
);
