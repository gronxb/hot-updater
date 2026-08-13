import React from "react";

import { Stack } from "../route-stack";
import { InstallFingerprintUpdateActionScreen } from "../screens/install-fingerprint-update-action-screen";

export const installFingerprintUpdateActionRoute = (
  <Stack.Screen
    name="InstallFingerprintUpdateAction"
    component={InstallFingerprintUpdateActionScreen}
  />
);
