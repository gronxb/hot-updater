import React from "react";

import { Stack } from "../route-stack";
import { CohortInputScreen } from "../screens/cohort-input-screen";
import { RuntimeChannelInputScreen } from "../screens/runtime-channel-input-screen";

export const inputRoutes = (
  <>
    <Stack.Screen name="CohortInput" component={CohortInputScreen} />
    <Stack.Screen
      name="RuntimeChannelInput"
      component={RuntimeChannelInputScreen}
    />
  </>
);
