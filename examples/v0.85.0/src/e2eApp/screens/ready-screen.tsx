import React from "react";
import { SafeAreaView } from "react-native";

import { ValueText } from "../components";

export const ReadyScreen = () => (
  <SafeAreaView style={{ flex: 1 }}>
    <ValueText testID="e2e-ready-status" value="Ready" />
  </SafeAreaView>
);
