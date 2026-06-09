import React from "react";

import { Stack } from "../route-stack";
import { ReadyScreen } from "../screens/ready-screen";

export const readyRoutes = (
  <Stack.Screen name="Ready" component={ReadyScreen} />
);
