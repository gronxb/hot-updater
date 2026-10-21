import React from "react";

import { Stack } from "../route-stack";
import { RuntimeMarkerScreen } from "../screens/runtime-marker-screen";

export const runtimeMarkerRoute = (
  <Stack.Screen name="RuntimeMarker" component={RuntimeMarkerScreen} />
);
