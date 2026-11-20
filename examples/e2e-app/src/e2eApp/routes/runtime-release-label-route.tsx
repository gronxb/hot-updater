import React from "react";

import { Stack } from "../route-stack";
import { RuntimeReleaseLabelScreen } from "../screens/runtime-release-label-screen";

export const runtimeReleaseLabelRoute = (
  <Stack.Screen
    name="RuntimeReleaseLabel"
    component={RuntimeReleaseLabelScreen}
  />
);
