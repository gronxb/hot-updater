import {
  NavigationContainer,
  type LinkingOptions,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";
import { SafeAreaView, Text } from "react-native";
import { enableScreens } from "react-native-screens";

import {
  ActionsScreen,
  CohortActionsScreen,
  ResultsScreen,
  RuntimeScreen,
} from "./screens";
import { styles } from "./styles";
import type { RootStackParamList } from "./types";
import { useE2eRuntimeModel } from "./useE2eRuntime";

enableScreens();

const Stack = createNativeStackNavigator<RootStackParamList>();

const e2eLinking: LinkingOptions<RootStackParamList> = {
  config: {
    screens: {
      Actions: "e2e/actions",
      CohortActions: "e2e/cohorts",
      Results: "e2e/results",
      Runtime: "e2e/runtime",
    },
  },
  prefixes: ["hotupdaterexample://"],
};

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
      <Stack.Navigator
        initialRouteName="Runtime"
        screenOptions={{ headerShown: false }}
      >
        <Stack.Screen name="Runtime">
          {({ navigation }) => (
            <RuntimeScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
        <Stack.Screen name="Actions">
          {({ navigation }) => (
            <ActionsScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
        <Stack.Screen name="CohortActions">
          {({ navigation }) => (
            <CohortActionsScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
        <Stack.Screen name="Results">
          {({ navigation }) => (
            <ResultsScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
};
