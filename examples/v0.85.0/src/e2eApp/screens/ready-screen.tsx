import React from "react";
import { SafeAreaView, Text } from "react-native";

import { styles } from "../styles";

export const ReadyScreen = () => (
  <SafeAreaView style={styles.safeArea}>
    <Text selectable style={styles.resultText} testID="e2e-ready-status">
      Ready
    </Text>
  </SafeAreaView>
);
