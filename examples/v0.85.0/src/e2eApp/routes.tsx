import React from "react";

import { registeredRouteElements } from "./registered-route-elements";
import { Stack } from "./route-stack";

export const E2eStack = (): React.JSX.Element => (
  <Stack.Navigator
    initialRouteName="Ready"
    screenOptions={{ headerShown: false }}
  >
    {registeredRouteElements}
  </Stack.Navigator>
);
