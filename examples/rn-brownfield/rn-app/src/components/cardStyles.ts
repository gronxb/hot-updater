import { StyleSheet } from 'react-native';

export const cardStyles = StyleSheet.create({
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
