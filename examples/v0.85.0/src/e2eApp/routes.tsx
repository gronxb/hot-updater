import React from "react";

import { registeredRouteElements } from "./registered-route-elements";
import { Stack } from "./route-stack";
import { styles } from "./styles";

export const E2eStack = (): React.JSX.Element => (
  <Stack.Navigator
    initialRouteName="Ready"
    screenOptions={{ contentStyle: styles.content, headerShown: false }}
  >
    {registeredRouteElements}
  </Stack.Navigator>
);
