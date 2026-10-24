import React from "react";

import { Stack } from "../route-stack";
import { ReloadAppActionScreen } from "../screens/reload-app-action-screen";

export const reloadAppActionRoute = (
  <Stack.Screen name="ReloadAppAction" component={ReloadAppActionScreen} />
);
