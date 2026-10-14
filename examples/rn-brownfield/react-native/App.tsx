import React from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';

type Props = {
  host?: string;
};

export default function App({ host }: Props) {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>Hello from React Native</Text>
        <Text style={styles.body}>
          This screen ships inside the RnBrownfieldReact framework and the
          rnbrownfieldreact AAR, and is rendered by a native host app.
        </Text>
        <Text style={styles.meta}>Host: {host ?? 'unknown'}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f2f4f7',
    alignItems: 'center',
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
