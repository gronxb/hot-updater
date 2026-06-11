import { StyleSheet } from "react-native";

export const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    backgroundColor: "#155e75",
    borderRadius: 8,
    justifyContent: "center",
    marginTop: 10,
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 10,
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
  resultText: {
    color: "#1f2937",
    fontSize: 13,
    fontWeight: "600",
    lineHeight: 19,
    marginTop: 8,
  },
});
