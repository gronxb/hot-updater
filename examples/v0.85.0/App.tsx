import React from "react";

import { E2eHotUpdaterApp } from "./src/e2eApp";
import {
  E2E_SCENARIO_MARKER,
  loadE2EDeployBundleAssets,
  maybeCrashForE2E,
} from "./src/e2eApp/patchSurface";

maybeCrashForE2E();
loadE2EDeployBundleAssets();

function App(): React.JSX.Element {
  return <E2eHotUpdaterApp scenarioMarker={E2E_SCENARIO_MARKER} />;
}

export default App;
