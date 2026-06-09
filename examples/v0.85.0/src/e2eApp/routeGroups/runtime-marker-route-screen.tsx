import React from "react";

import { Stack } from "../route-stack";
import { RuntimeMarkerScreen } from "../screens/runtime-marker-screen";

export const runtimeMarkerRouteScreen = (
  <Stack.Screen
    key="RuntimeMarker"
    name="RuntimeMarker"
    component={RuntimeMarkerScreen}
  />
);
