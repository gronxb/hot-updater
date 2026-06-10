import React from "react";

import { ScreenShell, ValueText } from "../components";

export const ReadyScreen = () => (
  <ScreenShell>
    <ValueText testID="e2e-ready-status" value="Ready" />
  </ScreenShell>
);
