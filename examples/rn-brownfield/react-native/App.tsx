import React from 'react';
import {
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import ReactNativeBrownfield from '@callstack/react-native-brownfield';

type Props = {
  host?: string;
};

export default function App({ host }: Props) {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={() => ReactNativeBrownfield.popToNative(true)}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <Text style={styles.backLabel}>‹ Back to native</Text>
        </Pressable>
      </View>

      <View style={styles.content}>
        <View style={styles.card}>
          <Text style={styles.title}>Hello from React Native</Text>
          <Text style={styles.body}>
            This screen is a React Native root view pushed full-screen by the
            native host. The JavaScript bundle ships inside the
            RnBrownfieldReact XCFramework and the rnbrownfieldreact AAR.
          </Text>
          <Text style={styles.body}>
            The back button above calls popToNative(), which pops this screen
            off the host's native navigation stack.
          </Text>
          <Text style={styles.meta}>Host: {host ?? 'unknown'}</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f2f4f7',
  },
  header: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  back: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  pressed: {
    backgroundColor: '#e5e7eb',
  },
  backLabel: {
    fontSize: 17,
    fontWeight: '500',
    color: '#2563eb',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
  },
  card: {
    marginHorizontal: 24,
    padding: 24,
    borderRadius: 16,
    backgroundColor: '#ffffff',
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: '#111827',
  },
  body: {
    fontSize: 16,
    lineHeight: 22,
    color: '#374151',
  },
  meta: {
    fontSize: 14,
    color: '#6b7280',
  },
});
