import React from "react";

import { Stack } from "../route-stack";
import { UpdateStoreDownloadPathsScreen } from "../screens/update-store-download-paths-screen";

export const updateStoreDownloadPathsRouteScreen = (
  <Stack.Screen
    key="UpdateStoreDownloadPaths"
    name="UpdateStoreDownloadPaths"
    component={UpdateStoreDownloadPathsScreen}
  />
);
