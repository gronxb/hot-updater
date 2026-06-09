import React from "react";

import { Stack } from "./route-stack";
import { cohortActionRouteScreens } from "./routeGroups/cohort-action-route-screens";
import { installActionRouteScreens } from "./routeGroups/install-action-route-screens";
import { resultAssertionRouteScreens } from "./routeGroups/result-assertion-route-screens";
import { runtimeActionRouteScreens } from "./routeGroups/runtime-action-route-screens";
import { runtimeAssertionRouteScreens } from "./routeGroups/runtime-assertion-route-screens";
import { stateAssertionRouteScreens } from "./routeGroups/state-assertion-route-screens";
import { ReadyScreen } from "./screens/ready-screen";

export const E2eStack = (): React.JSX.Element => (
  <Stack.Navigator
    initialRouteName="Ready"
    screenOptions={{ headerShown: false }}
  >
    <Stack.Screen name="Ready" component={ReadyScreen} />
    {runtimeAssertionRouteScreens}
    {stateAssertionRouteScreens}
    {resultAssertionRouteScreens}
    {installActionRouteScreens}
    {runtimeActionRouteScreens}
    {cohortActionRouteScreens}
  </Stack.Navigator>
);
