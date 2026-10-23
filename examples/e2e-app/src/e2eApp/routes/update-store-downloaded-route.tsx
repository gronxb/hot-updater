import React from "react";

import { Stack } from "../route-stack";
import { UpdateStoreDownloadedScreen } from "../screens/update-store-downloaded-screen";

export const updateStoreDownloadedRoute = (
  <Stack.Screen
    name="UpdateStoreDownloaded"
    component={UpdateStoreDownloadedScreen}
  />
);
