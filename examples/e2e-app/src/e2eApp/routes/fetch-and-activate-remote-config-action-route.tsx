import React from "react";

import { Stack } from "../route-stack";
import { FetchAndActivateRemoteConfigActionScreen } from "../screens/fetch-and-activate-remote-config-action-screen";

export const fetchAndActivateRemoteConfigActionRoute = (
  <Stack.Screen
    name="FetchAndActivateRemoteConfigAction"
    component={FetchAndActivateRemoteConfigActionScreen}
  />
);
