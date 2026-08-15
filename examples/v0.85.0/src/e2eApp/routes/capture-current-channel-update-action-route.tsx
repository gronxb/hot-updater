import React from "react";

import { Stack } from "../route-stack";
import { CaptureCurrentChannelUpdateActionScreen } from "../screens/capture-current-channel-update-action-screen";

export const captureCurrentChannelUpdateActionRoute = (
  <Stack.Screen
    name="CaptureCurrentChannelUpdateAction"
    component={CaptureCurrentChannelUpdateActionScreen}
  />
);
