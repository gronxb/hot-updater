import React from "react";

import { useE2eRuntimeModelContext } from "../runtime-model-context";
import { ActionButtonScreen } from "./action-button-screen";

export const ReinitializeHotUpdaterActionScreen = () => {
  const model = useE2eRuntimeModelContext();

  return (
    <ActionButtonScreen
      onPress={model.reinitializeHotUpdater}
      testID="action-reinitialize-hot-updater"
      title="Init Again"
    />
  );
};
