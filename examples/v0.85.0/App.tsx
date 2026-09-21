import React from "react";
import { Image } from "react-native";

import { E2eHotUpdaterApp } from "./src/e2eApp";
import {
  E2E_SCENARIO_MARKER,
  loadE2EDeployBundleAssets,
  maybeCrashForE2E,
} from "./src/e2eApp/patchSurface";

maybeCrashForE2E();
loadE2EDeployBundleAssets();
// Keep the same real font in native and OTA outputs for first-install reuse QA.
Image.resolveAssetSource(require("./src/test/builtin_reuse.ttf"));

function App(): React.JSX.Element {
  return <E2eHotUpdaterApp scenarioMarker={E2E_SCENARIO_MARKER} />;
}

export default App;
