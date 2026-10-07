/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import {
  HotUpdater,
  insights,
  useHotUpdaterStore,
} from "@hot-updater/react-native";
import React, { useEffect, useState } from "react";
import { Alert, Button, Image, SafeAreaView, Text } from "react-native";
import { proxy, useSnapshot } from "valtio";

const notify = proxy<{
  status?: string;
  crashedBundleId?: string;
}>({});

export const extractFormatDateFromUUIDv7 = (uuid: string) => {
  const timestampHex = uuid.split("-").join("").slice(0, 12);
  const timestamp = Number.parseInt(timestampHex, 16);

  const date = new Date(timestamp);
  const year = date.getFullYear().toString().slice(2);
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");

  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
};

HotUpdater.init({
  baseURL: "http://localhost:3006/hot-updater",
  plugins: [insights()],
  onNotifyAppReady: (result) => {
    notify.status = result.status;
    notify.crashedBundleId = result.crashedBundleId;
  },
});

/** Checks once per launch as the app mounts; a forced update restarts it. */
const checkForUpdate = async () => {
  try {
    const update = await HotUpdater.checkForUpdate({
      updateStrategy: "appVersion",
    });
    if (!update) return;
    await update.updateBundle();
    if (update.shouldForceUpdate) await HotUpdater.reload();
  } catch (error) {
    console.error("Hot Updater:", error);
  }
};

function App(): React.JSX.Element {
  useEffect(() => {
    void checkForUpdate();
  }, []);

  const state = useSnapshot(notify);
  const [bundleId, setBundleId] = useState<string | null>(null);

  useEffect(() => {
    const bundleId = HotUpdater.getBundleId();
    setBundleId(bundleId);
  }, []);

  const progress = useHotUpdaterStore((state) => state.progress);
  return (
    <SafeAreaView>
      <Text>Babel {HotUpdater.getBundleId()}</Text>
      <Text>Channel "{HotUpdater.getChannel()}"</Text>
      <Text>App Version "{HotUpdater.getAppVersion()}"</Text>

      <Text>{extractFormatDateFromUUIDv7(HotUpdater.getBundleId())}</Text>
      <Text
        style={{
          marginVertical: 20,
          fontSize: 20,
          fontWeight: "bold",
          textAlign: "center",
        }}
      >
        Hot Updater 0
      </Text>

      <Text
        style={{
          marginVertical: 20,
          fontSize: 20,
          fontWeight: "bold",
          textAlign: "center",
        }}
      >
        Update {Math.round(progress * 100)}%
      </Text>
      <Text
        style={{
          marginVertical: 20,
          fontSize: 20,
          fontWeight: "bold",
          textAlign: "center",
        }}
      >
        BundleId: {bundleId}
      </Text>

      <Text
        style={{
          marginVertical: 20,
          fontSize: 20,
          fontWeight: "bold",
          textAlign: "center",
        }}
      >
        Crash History:
      </Text>
      {HotUpdater.getCrashHistory().map((crash) => (
        <Text
          key={crash}
          style={{
            marginVertical: 20,
            fontSize: 20,
            fontWeight: "bold",
            textAlign: "center",
          }}
        >
          {crash}
        </Text>
      ))}

      <Image
        style={{
          width: 100,
          height: 100,
        }}
        // source={require("./src/logo.png")}
        source={require("./src/test/_image.png")}
      />

      <Text>{JSON.stringify(state, null, 2)}</Text>

      <Button title="Reload" onPress={() => HotUpdater.reload()} />
      <Button
        title="Clear Crash History"
        onPress={() => HotUpdater.clearCrashHistory()}
      />
    </SafeAreaView>
  );
}

export default App;
