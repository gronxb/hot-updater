import React from "react";

import { Stack } from "../route-stack";
import { LaunchTransitionScreen } from "../screens/launch-transition-screen";

export const launchTransitionRoute = (
  <Stack.Screen name="LaunchTransition" component={LaunchTransitionScreen} />
);
