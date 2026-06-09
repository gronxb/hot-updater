import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";

import { ReadyScreen } from "./screens";
import { modelScreens } from "./stack-screens";
import type { RootStackParamList } from "./types";
import type { E2eRuntimeModel } from "./useE2eRuntime";

const Stack = createNativeStackNavigator<RootStackParamList>();

export const E2eStack = ({
  model,
}: {
  readonly model: E2eRuntimeModel;
}): React.JSX.Element => (
  <Stack.Navigator
    initialRouteName="Ready"
    screenOptions={{ headerShown: false }}
  >
    <Stack.Screen name="Ready" component={ReadyScreen} />
    {modelScreens.map((screen) => (
      <Stack.Screen key={screen.name} name={screen.name}>
        {() => screen.render(model)}
      </Stack.Screen>
    ))}
  </Stack.Navigator>
);
