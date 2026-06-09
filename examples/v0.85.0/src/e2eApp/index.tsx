import { NavigationContainer } from "@react-navigation/native";
import React from "react";
import { SafeAreaView, Text } from "react-native";
import { enableScreens } from "react-native-screens";

import { e2eLinking } from "./route-paths";
import { E2eStack } from "./routes";
import { styles } from "./styles";
import { useE2eRuntimeModel } from "./useE2eRuntime";

enableScreens();

export const E2eHotUpdaterApp = ({
  scenarioMarker,
}: {
  readonly scenarioMarker: string;
}): React.JSX.Element => {
  const model = useE2eRuntimeModel(scenarioMarker);

  return (
    <NavigationContainer
      fallback={
        <SafeAreaView style={styles.safeArea}>
          <Text style={styles.description} testID="e2e-navigation-loading">
            Loading
          </Text>
        </SafeAreaView>
      }
      linking={e2eLinking}
    >
      <E2eStack model={model} />
    </NavigationContainer>
  );
};
