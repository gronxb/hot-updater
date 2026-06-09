import React, { type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable, SafeAreaView, Text, View } from "react-native";

import { screenContentTestIDs } from "./screen-test-ids";
import { styles } from "./styles";
import type { ScreenName } from "./types";

export const InfoRow = ({
  label,
  value,
  valueTestID,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueTestID?: string;
}) => (
  <View style={styles.infoRow}>
    <Text style={styles.infoLabel}>{label}</Text>
    <Text selectable style={styles.infoValue} testID={valueTestID}>
      {value}
    </Text>
  </View>
);

export const Button = ({
  deferPress = false,
  onPress,
  testID,
  title,
}: {
  readonly deferPress?: boolean;
  readonly onPress: () => Promise<void> | void;
  readonly testID: string;
  readonly title: string;
}) => {
  const onPressRef = useRef(onPress);
  const [deferredPressCount, setDeferredPressCount] = useState(0);

  useEffect(() => {
    onPressRef.current = onPress;
  }, [onPress]);

  useEffect(() => {
    if (deferredPressCount === 0) return;
    void onPressRef.current();
  }, [deferredPressCount]);

  const runPress = () => {
    if (deferPress) {
      setDeferredPressCount((count) => count + 1);
      return;
    }

    void onPress();
  };

  return (
    <Pressable
      accessibilityLabel={title}
      accessibilityRole="button"
      onPress={() => {
        runPress();
      }}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      testID={testID}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
};

export const ScreenShell = ({
  children,
  current,
}: {
  readonly children: ReactNode;
  readonly current: ScreenName;
}) => (
  <SafeAreaView style={styles.safeArea}>
    <View style={styles.content} testID={screenContentTestIDs[current]}>
      {children}
    </View>
  </SafeAreaView>
);
