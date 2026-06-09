import React from "react";

import { Stack } from "../route-stack";
import { UpdateStoreDownloadPathsScreen } from "../screens/update-store-download-paths-screen";
import { UpdateStoreDownloadedScreen } from "../screens/update-store-downloaded-screen";

export const statusUpdateStoreRoutes = (
  <>
    <Stack.Screen
      name="UpdateStoreDownloaded"
      component={UpdateStoreDownloadedScreen}
    />
    <Stack.Screen
      name="UpdateStoreDownloadPaths"
      component={UpdateStoreDownloadPathsScreen}
    />
  </>
);
