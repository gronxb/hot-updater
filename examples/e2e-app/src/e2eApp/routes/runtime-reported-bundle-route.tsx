import React from "react";

import { Stack } from "../route-stack";
import { RuntimeReportedBundleScreen } from "../screens/runtime-reported-bundle-screen";

export const runtimeReportedBundleRoute = (
  <Stack.Screen
    name="RuntimeReportedBundle"
    component={RuntimeReportedBundleScreen}
  />
);
