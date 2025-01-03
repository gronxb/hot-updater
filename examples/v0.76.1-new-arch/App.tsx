/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import { HotUpdater, useHotUpdaterStore } from "@hot-updater/react-native";
import type React from "react";
import { useEffect, useState } from "react";
import { Button, Image, SafeAreaView, Text } from "react-native";

HotUpdater.init({
  source: "https://gronxb.s3.ap-northeast-2.amazonaws.com/update.json",
});

function extractTimestampFromUUIDv7(uuid: string) {
  const timestampHex = uuid.split("-").join("").slice(0, 12);

  const timestamp = Number.parseInt(timestampHex, 16);

  return timestamp;
}

function App(): React.JSX.Element {
  const [bundleId, setBundleId] = useState<string | null>(null);

  const { progress } = useHotUpdaterStore();

  useEffect(() => {
    const bundleId = HotUpdater.getBundleId();
    setBundleId(bundleId);
  }, []);

  // @ts-expect-error
  const isTurboModuleEnabled = global.__turboModuleProxy != null;

  return (
    <SafeAreaView>
      <Text>Progress: {Math.round(progress * 100)}%</Text>
      <Text>Babel {HotUpdater.HOT_UPDATER_BUNDLE_ID}</Text>
      <Text>
        Babel {extractTimestampFromUUIDv7(HotUpdater.HOT_UPDATER_BUNDLE_ID)}
      </Text>
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
        isTurboModuleEnabled: {isTurboModuleEnabled ? "true" : "false"}
      </Text>

      <Image
        style={{
          width: 100,
          height: 100,
        }}
        source={require("./src/logo.png")}
        // source={require("./src/test/_image.png")}
      />

      <Button title="Reload" onPress={() => HotUpdater.reload()} />
    </SafeAreaView>
  );
}

export default App;
