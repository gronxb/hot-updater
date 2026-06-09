import {
  NavigationContainer,
  type LinkingOptions,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";
import { SafeAreaView, Text } from "react-native";
import { enableScreens } from "react-native-screens";

import {
  ActionResultsScreen,
  CohortInputActionsScreen,
  CohortPresetActionsScreen,
  CrashHistoryScreen,
  InstallActionsScreen,
  LaunchStatusScreen,
  RuntimeChannelActionsScreen,
  RuntimeIdentityScreen,
  RuntimeStateScreen,
  UpdateStoreScreen,
} from "./screens";
import { styles } from "./styles";
import type { RootStackParamList } from "./types";
import { useE2eRuntimeModel } from "./useE2eRuntime";

enableScreens();

const Stack = createNativeStackNavigator<RootStackParamList>();

const e2eLinking: LinkingOptions<RootStackParamList> = {
  config: {
    screens: {
      ActionResults: "e2e/results",
      CohortInputActions: "e2e/cohort-input",
      CohortPresetActions: "e2e/cohort-presets",
      CrashHistory: "e2e/crash-history",
      InstallActions: "e2e/install",
      LaunchStatus: "e2e/launch-status",
      RuntimeChannelActions: "e2e/runtime-channel",
      RuntimeIdentity: "e2e/runtime-identity",
      RuntimeState: "e2e/runtime-state",
      UpdateStore: "e2e/update-store",
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
        initialRouteName="RuntimeIdentity"
        screenOptions={{ headerShown: false }}
      >
        <Stack.Screen name="RuntimeIdentity">
          {({ navigation }) => (
            <RuntimeIdentityScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
        <Stack.Screen name="LaunchStatus">
          {({ navigation }) => (
            <LaunchStatusScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
        <Stack.Screen name="RuntimeState">
          {({ navigation }) => (
            <RuntimeStateScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
        <Stack.Screen name="UpdateStore">
          {({ navigation }) => (
            <UpdateStoreScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
        <Stack.Screen name="CrashHistory">
          {({ navigation }) => (
            <CrashHistoryScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
        <Stack.Screen name="InstallActions">
          {({ navigation }) => (
            <InstallActionsScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
        <Stack.Screen name="RuntimeChannelActions">
          {({ navigation }) => (
            <RuntimeChannelActionsScreen
              model={model}
              navigation={navigation}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="CohortInputActions">
          {({ navigation }) => (
            <CohortInputActionsScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
        <Stack.Screen name="CohortPresetActions">
          {({ navigation }) => (
            <CohortPresetActionsScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
        <Stack.Screen name="ActionResults">
          {({ navigation }) => (
            <ActionResultsScreen model={model} navigation={navigation} />
          )}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
};
