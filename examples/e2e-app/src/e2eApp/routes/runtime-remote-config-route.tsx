import React from "react";

import { Stack } from "../route-stack";
import { RuntimeRemoteConfigScreen } from "../screens/runtime-remote-config-screen";

export const runtimeRemoteConfigRoute = (
  <Stack.Screen
    name="RuntimeRemoteConfig"
    component={RuntimeRemoteConfigScreen}
  />
);
