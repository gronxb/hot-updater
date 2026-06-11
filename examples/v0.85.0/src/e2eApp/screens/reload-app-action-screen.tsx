import React from "react";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { ActionButtonScreen } from "./action-button-screen";

export const ReloadAppActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ActionButtonScreen
      onPress={model.reloadApp}
      testID="action-reload-app"
      title="Reload"
    />
  );
};
