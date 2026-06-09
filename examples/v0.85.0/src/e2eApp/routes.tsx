import React from "react";

import { Stack } from "./route-stack";
import { assertionRouteScreens } from "./routeGroups/assertion-route-screens";
import { interactionRouteScreens } from "./routeGroups/interaction-route-screens";
import { ReadyScreen } from "./screens/ready-screen";

export const E2eStack = (): React.JSX.Element => (
  <Stack.Navigator
    initialRouteName="Ready"
    screenOptions={{ headerShown: false }}
  >
    <Stack.Screen name="Ready" component={ReadyScreen} />
    {assertionRouteScreens}
    {interactionRouteScreens}
  </Stack.Navigator>
);
