import React from "react";

import { Stack } from "../route-stack";
import { UpdateDiagnosticsScreen } from "../screens/update-diagnostics-screen";

export const updateDiagnosticsRoute = (
  <Stack.Screen name="UpdateDiagnostics" component={UpdateDiagnosticsScreen} />
);
