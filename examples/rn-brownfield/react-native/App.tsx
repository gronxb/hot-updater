import React from 'react';
import {
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import ReactNativeBrownfield from '@callstack/react-native-brownfield';

import { HotUpdaterCard } from './src/components/HotUpdaterCard';
import { NativeHostCard } from './src/components/NativeHostCard';
import { hotUpdater } from './src/hotUpdater';

type Props = {
  host?: string;
};

function App({ host }: Props) {
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

      <ScrollView contentContainerStyle={styles.content}>
        <NativeHostCard host={host} />
        <HotUpdaterCard />
      </ScrollView>
    </SafeAreaView>
  );
}

// Checks for an update when the screen mounts and applies it, showing the
// fallback until the check completes.
export default hotUpdater.wrap({
  updateStrategy: 'fingerprint',
  fallbackComponent: ({ progress, status }) => (
    <Modal transparent visible={true}>
      <View style={styles.fallback}>
        <Text style={styles.fallbackLabel}>
          {status === 'UPDATING' ? 'Updating...' : 'Checking for update...'}
        </Text>
        {progress > 0 ? (
          <Text style={styles.fallbackLabel}>
            {Math.round(progress * 100)}%
          </Text>
        ) : null}
      </View>
    </Modal>
  ),
})(App);

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
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 24,
    gap: 16,
  },
  fallback: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  fallbackLabel: {
    color: 'white',
    fontSize: 20,
    fontWeight: 'bold',
  },
});
