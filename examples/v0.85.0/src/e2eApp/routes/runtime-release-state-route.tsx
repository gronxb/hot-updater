import React from "react";

import { Stack } from "../route-stack";
import { RuntimeReleaseStateScreen } from "../screens/runtime-release-state-screen";

export const runtimeReleaseStateRoute = (
  <Stack.Screen
    name="RuntimeReleaseState"
    component={RuntimeReleaseStateScreen}
  />
);
