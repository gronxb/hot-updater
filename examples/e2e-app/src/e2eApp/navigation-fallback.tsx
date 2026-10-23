import React from "react";

import { ValueText } from "./components";

export const NavigationFallback = (): React.JSX.Element => (
  <ValueText testID="e2e-navigation-loading" value="Loading" />
);
