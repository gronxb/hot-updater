import React from "react";

import { Stack } from "../route-stack";
import { UpdateStoreDownloadPathsScreen } from "../screens/update-store-download-paths-screen";

export const updateStoreDownloadPathsRoute = (
  <Stack.Screen
    name="UpdateStoreDownloadPaths"
    component={UpdateStoreDownloadPathsScreen}
  />
);
