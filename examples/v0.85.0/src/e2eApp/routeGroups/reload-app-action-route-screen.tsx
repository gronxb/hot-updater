import React from "react";

import { Stack } from "../route-stack";
import { ReloadAppActionScreen } from "../screens/reload-app-action-screen";

export const reloadAppActionRouteScreen = (
  <Stack.Screen
    key="ReloadAppAction"
    name="ReloadAppAction"
    component={ReloadAppActionScreen}
  />
);
