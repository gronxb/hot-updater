import { NavigationContainer } from "@react-navigation/native";
import React, { useEffect } from "react";
import { enableScreens } from "react-native-screens";

import {
  flushPendingE2eDeepLink,
  navigationRef,
  useE2eDeepLinks,
} from "./navigation-controller";
import { NavigationFallback } from "./navigation-fallback";
import { E2eRenderErrorBoundary } from "./render-error-boundary";
import { e2eLinking } from "./route-paths";
import { E2eStack } from "./routes";
import { initHotUpdaterAfterFirstRender } from "./runtime";
import { E2eRuntimeModelProvider } from "./runtime-model-context";
import { useE2eRuntimeModel } from "./useE2eRuntime";

enableScreens();

export const E2eHotUpdaterApp = ({
  scenarioMarker,
}: {
  readonly scenarioMarker: string;
}): React.JSX.Element => {
  const model = useE2eRuntimeModel(scenarioMarker);
  useE2eDeepLinks();
  useEffect(initHotUpdaterAfterFirstRender, []);

  return (
    <E2eRenderErrorBoundary>
      <E2eRuntimeModelProvider model={model}>
        <NavigationContainer
          fallback={<NavigationFallback />}
          linking={e2eLinking}
          onReady={flushPendingE2eDeepLink}
          ref={navigationRef}
        >
          <E2eStack />
        </NavigationContainer>
      </E2eRuntimeModelProvider>
    </E2eRenderErrorBoundary>
  );
};
