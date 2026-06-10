import React, { type ReactNode, useRef } from "react";
import { Pressable, SafeAreaView, Text, View } from "react-native";

import { styles } from "./styles";

export const ValueText = ({
  testID,
  value,
}: {
  readonly testID: string;
  readonly value: string;
}) => (
  <Text selectable style={styles.resultText} testID={testID}>
    {value}
  </Text>
);

export const Button = ({
  onPress,
  testID,
  title,
}: {
  readonly onPress: () => Promise<void> | void;
  readonly testID: string;
  readonly title: string;
}) => (
  <Pressable
    accessibilityLabel={title}
    accessibilityRole="button"
    onPress={() => {
      void onPress();
    }}
    style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    testID={testID}
  >
    <Text style={styles.buttonText}>{title}</Text>
  </Pressable>
);

export const PressInActionButton = ({
  onPress,
  testID,
  title,
}: {
  readonly onPress: () => Promise<void> | void;
  readonly testID: string;
  readonly title: string;
}) => {
  const didRun = useRef(false);
  const runOnce = () => {
    if (didRun.current) return;
    didRun.current = true;
    void onPress();
  };

  return (
    <Pressable
      accessibilityLabel={title}
      accessibilityRole="button"
      onPressIn={runOnce}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      testID={testID}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
};

export const ScreenShell = ({ children }: { readonly children: ReactNode }) => (
  <SafeAreaView style={styles.safeArea}>
    <View style={styles.content}>{children}</View>
  </SafeAreaView>
);
