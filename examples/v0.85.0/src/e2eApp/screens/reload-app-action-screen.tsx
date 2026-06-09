import React from "react";

import { ActionButtonScreen } from "./action-button-screen";
import type { ScreenProps } from "./types";

export const ReloadAppActionScreen = ({ model }: ScreenProps) => (
  <ActionButtonScreen
    current="ReloadAppAction"
    onPress={model.reloadApp}
    testID="action-reload-app"
    title="Reload"
  />
);
