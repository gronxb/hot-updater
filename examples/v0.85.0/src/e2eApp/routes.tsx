import React from "react";

import { Stack } from "./route-stack";
import { actionRoutes } from "./routes/action-routes";
import { inputRoutes } from "./routes/input-routes";
import { readyRoutes } from "./routes/ready-routes";
import { runtimeRoutes } from "./routes/runtime-routes";
import { statusRoutes } from "./routes/status-routes";

export const E2eStack = (): React.JSX.Element => (
  <Stack.Navigator
    initialRouteName="Ready"
    screenOptions={{ headerShown: false }}
  >
    {readyRoutes}
    {runtimeRoutes}
    {statusRoutes}
    {inputRoutes}
    {actionRoutes}
  </Stack.Navigator>
);
