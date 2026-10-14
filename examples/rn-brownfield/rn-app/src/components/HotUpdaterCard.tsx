import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useHotUpdaterStore } from '@hot-updater/react-native';

import { hotUpdater } from '../hotUpdater';
import { cardStyles } from './cardStyles';

// The time a bundle was built, read from its UUIDv7 bundle id.
export const extractFormatDateFromUUIDv7 = (uuid: string) => {
  const timestampHex = uuid.split('-').join('').slice(0, 12);
  const timestamp = Number.parseInt(timestampHex, 16);

  const date = new Date(timestamp);
  const year = date.getFullYear().toString().slice(2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');

  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
};

export function HotUpdaterCard() {
  const [bundleId, setBundleId] = useState<string | null>(null);

  useEffect(() => {
    setBundleId(hotUpdater.getBundleId());
  }, []);

  const progress = useHotUpdaterStore(state => state.progress);
  const isUpdateDownloaded = useHotUpdaterStore(
    state => state.isUpdateDownloaded,
  );

  return (
    <View style={cardStyles.card}>
      <Text style={cardStyles.title}>Hot Updater</Text>
      <Text style={cardStyles.body}>
        This bundle can be replaced over the air. The hosts ask Hot Updater for
        the bundle to load, so a deployed update takes over from the one
        embedded in the artifact.
      </Text>
      <Row label="Bundle id" value={bundleId ?? hotUpdater.getBundleId()} />
      <Row
        label="Built"
        value={extractFormatDateFromUUIDv7(hotUpdater.getBundleId())}
      />
      <Row label="Channel" value={hotUpdater.getChannel()} />
      <Row label="App version" value={hotUpdater.getAppVersion()} />
      <Row label="Fingerprint" value={hotUpdater.getFingerprintHash()} />
      <Row label="Update" value={`${Math.round(progress * 100)}%`} />
      <Row
        label="Downloaded"
        value={isUpdateDownloaded ? 'yes, reload to apply' : 'no'}
      />
      <Pressable
        accessibilityRole="button"
        onPress={() => hotUpdater.reload()}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        <Text style={styles.buttonLabel}>Reload</Text>
      </Pressable>
    </View>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} selectable>
        {value ?? '—'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: 2,
  },
  rowLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    color: '#6b7280',
  },
  rowValue: {
    fontSize: 15,
    color: '#111827',
    fontVariant: ['tabular-nums'],
  },
  button: {
    marginTop: 4,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#2563eb',
  },
  pressed: {
    opacity: 0.6,
  },
  buttonLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
});
