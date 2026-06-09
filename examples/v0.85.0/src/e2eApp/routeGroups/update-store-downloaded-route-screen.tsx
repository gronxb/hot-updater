import React from "react";

import { Stack } from "../route-stack";
import { UpdateStoreDownloadedScreen } from "../screens/update-store-downloaded-screen";

export const updateStoreDownloadedRouteScreen = (
  <Stack.Screen
    key="UpdateStoreDownloaded"
    name="UpdateStoreDownloaded"
    component={UpdateStoreDownloadedScreen}
  />
);
