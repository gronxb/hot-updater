import React from "react";

import { Stack } from "../route-stack";
import { ChannelActionResultScreen } from "../screens/channel-action-result-screen";

export const channelActionResultRouteScreen = (
  <Stack.Screen
    key="ChannelActionResult"
    name="ChannelActionResult"
    component={ChannelActionResultScreen}
  />
);
