import { NavigationContainer } from "@react-navigation/native";
import React from "react";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { enableScreens } from "react-native-screens";

import {
  flushPendingE2eDeepLink,
  navigationRef,
  useE2eDeepLinks,
} from "./navigation-controller";
import { NavigationFallback } from "./navigation-fallback";
import { e2eLinking } from "./route-paths";
import { E2eStack } from "./routes";
import { E2eRuntimeModelProvider } from "./runtime-model-context";
import { styles } from "./styles";
import { useE2eRuntimeModel } from "./useE2eRuntime";

enableScreens();

export const E2eHotUpdaterApp = ({
  scenarioMarker,
}: {
  readonly scenarioMarker: string;
}): React.JSX.Element => {
  const model = useE2eRuntimeModel(scenarioMarker);
  useE2eDeepLinks();

  return (
    <E2eRuntimeModelProvider model={model}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.safeArea}>
          <NavigationContainer
            fallback={<NavigationFallback />}
            linking={e2eLinking}
            onReady={flushPendingE2eDeepLink}
            ref={navigationRef}
          >
            <E2eStack />
          </NavigationContainer>
        </SafeAreaView>
      </SafeAreaProvider>
    </E2eRuntimeModelProvider>
  );
};
