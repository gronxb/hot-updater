import React from "react";

import { Stack } from "../route-stack";
import { RuntimeBundleScreen } from "../screens/runtime-bundle-screen";

export const runtimeBundleRoute = (
  <Stack.Screen name="RuntimeBundle" component={RuntimeBundleScreen} />
);
