import {
  NavigationContainer,
  type LinkingOptions,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";
import { SafeAreaView, Text } from "react-native";
import { enableScreens } from "react-native-screens";

import {
  ChannelActionResultScreen,
  CohortInputActionsScreen,
  CohortPresetActionsScreen,
  CohortActionResultScreen,
  CrashHistoryScreen,
  InstallActionsScreen,
  LaunchCrashedBundleScreen,
  LaunchStatusScreen,
  ReadyScreen,
  RuntimeChannelActionsScreen,
  RuntimeBundleScreen,
  RuntimeLargeAssetScreen,
  RuntimeMarkerScreen,
  RuntimeStateScreen,
  UpdateActionResultScreen,
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
      ChannelActionResult: "e2e/channel-action-result",
      CohortInputActions: "e2e/cohort-input",
      CohortPresetActions: "e2e/cohort-presets",
      CohortActionResult: "e2e/cohort-action-result",
      CrashHistory: "e2e/crash-history",
      InstallActions: "e2e/install",
      LaunchCrashedBundle: "e2e/launch-crashed-bundle",
      LaunchStatus: "e2e/launch-status",
      Ready: "e2e/ready",
      RuntimeChannelActions: "e2e/runtime-channel",
      RuntimeBundle: "e2e/runtime-bundle",
      RuntimeLargeAsset: "e2e/runtime-large-asset",
      RuntimeMarker: "e2e/runtime-marker",
      RuntimeState: "e2e/runtime-state",
      UpdateActionResult: "e2e/update-action-result",
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
        initialRouteName="Ready"
        screenOptions={{ headerShown: false }}
      >
        <Stack.Screen name="Ready" component={ReadyScreen} />
        <Stack.Screen name="RuntimeBundle">
          {() => <RuntimeBundleScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="RuntimeMarker">
          {() => <RuntimeMarkerScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="RuntimeLargeAsset">
          {() => <RuntimeLargeAssetScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="LaunchStatus">
          {() => <LaunchStatusScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="LaunchCrashedBundle">
          {() => <LaunchCrashedBundleScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="RuntimeState">
          {() => <RuntimeStateScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="UpdateStore">
          {() => <UpdateStoreScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="CrashHistory">
          {() => <CrashHistoryScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="InstallActions">
          {() => <InstallActionsScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="RuntimeChannelActions">
          {() => <RuntimeChannelActionsScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="CohortInputActions">
          {() => <CohortInputActionsScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="CohortPresetActions">
          {() => <CohortPresetActionsScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="ChannelActionResult">
          {() => <ChannelActionResultScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="UpdateActionResult">
          {() => <UpdateActionResultScreen model={model} />}
        </Stack.Screen>
        <Stack.Screen name="CohortActionResult">
          {() => <CohortActionResultScreen model={model} />}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
};
