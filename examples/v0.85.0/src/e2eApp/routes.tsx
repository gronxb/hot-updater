import React from "react";

import { Stack } from "./route-stack";
import { routeScreens } from "./routeGroups/route-screen-registry";
import { ReadyScreen } from "./screens/ready-screen";

export const E2eStack = (): React.JSX.Element => (
  <Stack.Navigator
    initialRouteName="Ready"
    screenOptions={{ headerShown: false }}
  >
    <Stack.Screen name="Ready" component={ReadyScreen} />
    {routeScreens}
  </Stack.Navigator>
);
