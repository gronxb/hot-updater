import React from "react";

import { Stack } from "../route-stack";
import { ReinitializeHotUpdaterActionScreen } from "../screens/reinitialize-hot-updater-action-screen";

export const reinitializeHotUpdaterActionRoute = (
  <Stack.Screen
    name="ReinitializeHotUpdaterAction"
    component={ReinitializeHotUpdaterActionScreen}
  />
);
