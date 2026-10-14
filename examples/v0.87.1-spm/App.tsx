import {
  HotUpdater,
  insights,
  useHotUpdaterStore,
} from "@hot-updater/react-native";
import React from "react";
import { Button, Modal, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import {
  HOT_UPDATER_API_KEY,
  HOT_UPDATER_APP_BASE_URL,
} from "./src/hotUpdaterBuildConfig";

const formatUUIDv7Time = (uuid: string) =>
  new Date(
    Number.parseInt(uuid.replaceAll("-", "").slice(0, 12), 16),
  ).toISOString();

export const hotUpdater = HotUpdater.init({
  // The hot-updater-v1 Edge Function URL, or HOT_UPDATER_APP_BASE_URL from the
  // build environment or .env.hotupdater (see hot-updater-build-config.cjs).
  baseURL:
    HOT_UPDATER_APP_BASE_URL ??
    "https://your-project.supabase.co/functions/v1/hot-updater-v1",
  // The client API key the server's apiKeys() requires: HOT_UPDATER_API_KEY,
  // which `hot-updater init` writes to .env.hotupdater.
  requestHeaders: HOT_UPDATER_API_KEY
    ? { "x-api-key": HOT_UPDATER_API_KEY }
    : undefined,
  plugins: [insights()],
});

const textStyle = { fontSize: 16, marginVertical: 4 } as const;

function App(): React.JSX.Element {
  const progress = useHotUpdaterStore((state) => state.progress);
  const minBundleId = hotUpdater.getMinBundleId();

  return (
    <SafeAreaProvider>
      <SafeAreaView>
        <View style={{ padding: 20 }}>
          <Text style={{ fontSize: 20, fontWeight: "bold", marginBottom: 12 }}>
            Hot Updater (Swift Package Manager)
          </Text>
          <Text style={textStyle} testID="bundleId">
            Bundle ID: {hotUpdater.getBundleId()}
          </Text>
          <Text style={textStyle} testID="minBundleId">
            MIN_BUNDLE_ID: {minBundleId}
          </Text>
          <Text style={textStyle}>
            Built at: {formatUUIDv7Time(minBundleId)}
          </Text>
          <Text style={textStyle}>Channel: {hotUpdater.getChannel()}</Text>
          <Text style={textStyle}>
            App Version: {hotUpdater.getAppVersion()}
          </Text>
          <Text style={textStyle}>Update: {Math.round(progress * 100)}%</Text>
          <Button title="Reload" onPress={() => hotUpdater.reload()} />
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

export default hotUpdater.wrap({
  updateStrategy: "appVersion",
  fallbackComponent: ({ progress, status }) => (
    <Modal transparent visible={true}>
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "rgba(0, 0, 0, 0.5)",
        }}
      >
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
