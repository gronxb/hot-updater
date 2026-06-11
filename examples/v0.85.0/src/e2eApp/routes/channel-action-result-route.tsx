import React from "react";

import { Stack } from "../route-stack";
import { ChannelActionResultScreen } from "../screens/channel-action-result-screen";

export const channelActionResultRoute = (
  <Stack.Screen
    name="ChannelActionResult"
    component={ChannelActionResultScreen}
  />
);
