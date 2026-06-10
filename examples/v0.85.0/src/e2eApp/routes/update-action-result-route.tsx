import React from "react";

import { Stack } from "../route-stack";
import { UpdateActionResultScreen } from "../screens/update-action-result-screen";

export const updateActionResultRoute = (
  <Stack.Screen
    name="UpdateActionResult"
    component={UpdateActionResultScreen}
  />
);
