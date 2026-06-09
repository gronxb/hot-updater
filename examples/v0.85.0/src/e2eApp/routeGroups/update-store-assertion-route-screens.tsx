import React from "react";

import { Stack } from "../route-stack";
import { UpdateStoreDownloadPathsScreen } from "../screens/update-store-download-paths-screen";
import { UpdateStoreDownloadedScreen } from "../screens/update-store-downloaded-screen";

export const updateStoreAssertionRouteScreens = [
  <Stack.Screen
    key="UpdateStoreDownloaded"
    name="UpdateStoreDownloaded"
    component={UpdateStoreDownloadedScreen}
  />,
  <Stack.Screen
    key="UpdateStoreDownloadPaths"
    name="UpdateStoreDownloadPaths"
    component={UpdateStoreDownloadPathsScreen}
  />,
] as const;
