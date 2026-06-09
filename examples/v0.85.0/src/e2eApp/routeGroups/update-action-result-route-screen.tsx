import React from "react";

import { Stack } from "../route-stack";
import { UpdateActionResultScreen } from "../screens/update-action-result-screen";

export const updateActionResultRouteScreen = (
  <Stack.Screen
    key="UpdateActionResult"
    name="UpdateActionResult"
    component={UpdateActionResultScreen}
  />
);
