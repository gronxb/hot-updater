import React from "react";

import { Stack } from "../route-stack";
import { UpdateStatusScreen } from "../screens/update-status-screen";

export const updateStatusRoute = (
  <Stack.Screen name="UpdateStatus" component={UpdateStatusScreen} />
);
