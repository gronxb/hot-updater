import React from "react";

import { Stack } from "../route-stack";
import { ActivateRemoteConfigActionScreen } from "../screens/activate-remote-config-action-screen";

export const activateRemoteConfigActionRoute = (
  <Stack.Screen
    name="ActivateRemoteConfigAction"
    component={ActivateRemoteConfigActionScreen}
  />
);
