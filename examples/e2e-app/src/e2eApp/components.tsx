import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useRef } from "react";
import { Pressable, Text } from "react-native";

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

export const FocusedActionRoute = ({
  onFocus,
  testID,
  title,
}: {
  readonly onFocus: () => Promise<void> | void;
  readonly testID: string;
  readonly title: string;
}) => {
  const didRun = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (didRun.current) return undefined;

      didRun.current = true;
      void onFocus();

      return undefined;
    }, [onFocus]),
  );

  return <ValueText testID={testID} value={title} />;
};
