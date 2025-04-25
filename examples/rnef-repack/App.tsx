import { HotUpdater } from "@hot-updater/react-native";
import React from "react";
import { Modal, StyleSheet, Text, View } from "react-native";

const App = () => {
  return (
    <View style={styles.container}>
      <Text>Welcome to React Native Enterprise Framework!</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
});

export default HotUpdater.wrap({
  source: `${process.env.HOT_UPDATER_SUPABASE_URL}/functions/v1/update-server`,
  fallbackComponent: ({ progress, status }) => (
    <Modal transparent visible={true}>
      <View
        style={{
          flex: 1,
          padding: 20,
          borderRadius: 10,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "rgba(0, 0, 0, 0.5)",
        }}
      >
        {/* You can put a splash image here. */}

        <Text style={{ color: "white", fontSize: 20, fontWeight: "bold" }}>
          {status === "UPDATING" ? "Updating..." : "Checking for Update..."}
        </Text>
        {progress > 0 ? (
          <Text style={{ color: "white", fontSize: 20, fontWeight: "bold" }}>
            {Math.round(progress * 100)}%
          </Text>
        ) : null}
      </View>
    </Modal>
  ),
})(App);
