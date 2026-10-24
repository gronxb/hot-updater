import React from "react";

import { Stack } from "../route-stack";
import { FetchRemoteConfigActionScreen } from "../screens/fetch-remote-config-action-screen";

export const fetchRemoteConfigActionRoute = (
  <Stack.Screen
    name="FetchRemoteConfigAction"
    component={FetchRemoteConfigActionScreen}
  />
);
