import { Platform, StyleSheet } from "react-native";

export const styles = StyleSheet.create({
  assetCard: {
    backgroundColor: "#f3f4f6",
    borderRadius: 8,
    marginTop: 10,
    padding: 12,
  },
  assetHash: {
    color: "#111827",
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 12,
    lineHeight: 18,
  },
  assetName: {
    color: "#111827",
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 6,
  },
  button: {
    alignItems: "center",
    backgroundColor: "#155e75",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  buttonGrid: {
    gap: 8,
    marginTop: 12,
  },
  buttonPressed: {
    backgroundColor: "#0e7490",
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
  },
  content: {
    flex: 1,
    padding: 18,
  },
  crashList: {
    marginTop: 4,
  },
  crashItem: {
    backgroundColor: "#fff7ed",
    borderRadius: 8,
    color: "#9a3412",
    fontSize: 13,
    marginTop: 8,
    padding: 10,
  },
  description: {
    color: "#475569",
    fontSize: 15,
    lineHeight: 21,
    marginTop: 6,
  },
  imageFrame: {
    alignItems: "center",
    backgroundColor: "#ecfeff",
    borderRadius: 8,
    marginTop: 8,
    padding: 18,
  },
  infoLabel: {
    color: "#64748b",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 4,
    textTransform: "uppercase",
  },
  infoRow: {
    borderBottomColor: "#e5e7eb",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 9,
  },
  infoValue: {
    color: "#111827",
    fontSize: 14,
    lineHeight: 20,
  },
  input: {
    backgroundColor: "#f8fafc",
    borderColor: "#cbd5e1",
    borderRadius: 8,
    borderWidth: 1,
    color: "#0f172a",
    fontSize: 15,
    marginTop: 10,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  previewImage: {
    height: 120,
    width: 120,
  },
  resultText: {
    color: "#1f2937",
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 19,
    marginTop: 8,
  },
  safeArea: {
    backgroundColor: "#f8fafc",
    flex: 1,
  },
  section: {
    backgroundColor: "#ffffff",
    borderRadius: 8,
    marginTop: 14,
    padding: 16,
  },
  sectionTitle: {
    color: "#111827",
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 6,
  },
  title: {
    color: "#111827",
    fontSize: 30,
    fontWeight: "800",
  },
});
