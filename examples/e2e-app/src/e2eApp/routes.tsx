import React from "react";

import { registeredRouteElements } from "./registered-route-elements";
import { Stack } from "./route-stack";
import { styles } from "./styles";

export const E2eStack = (): React.JSX.Element => (
  <Stack.Navigator
    initialRouteName="Ready"
    // Every deep link resets the stack. Without an animation the previous
    // screen leaves at once, so no read sees two screens' test IDs.
    screenOptions={{
      animation: "none",
      contentStyle: styles.content,
      headerShown: false,
    }}
  >
    {registeredRouteElements}
  </Stack.Navigator>
);
