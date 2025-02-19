/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import { HotUpdater, useHotUpdaterStore } from "@hot-updater/react-native";
// biome-ignore lint/style/useImportType: <explanation>
import React from "react";
import { useEffect, useState } from "react";
import { Button, Image, Modal, SafeAreaView, Text, View } from "react-native";

import { HOT_UPDATER_SUPABASE_URL } from "@env";

function App(): React.JSX.Element {
  const [bundleId, setBundleId] = useState<string | null>(null);

  useEffect(() => {
    const bundleId = HotUpdater.getBundleId();
    setBundleId(bundleId);
  }, []);

  // @ts-ignore
  const isTurboModuleEnabled = global.__turboModuleProxy != null;

  // @ts-ignore
  const isHermes = () => !!global.HermesInternal;

  const { progress } = useHotUpdaterStore();
  return (
    <SafeAreaView>
      <Text>Babel {HotUpdater.getBundleId()}</Text>
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
        isTurboModuleEnabled: {isTurboModuleEnabled ? "true" : "false"}
      </Text>
      <Text
        style={{
          marginVertical: 20,
          fontSize: 20,
          fontWeight: "bold",
          textAlign: "center",
        }}
      >
        isHermes: {isHermes() ? "true" : "false"}
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
      <Button
        title="HotUpdater.runUpdateProcess()"
        onPress={() =>
          HotUpdater.runUpdateProcess({
            source: `${HOT_UPDATER_SUPABASE_URL}/functions/v1/update-server`,
          }).then((status) => {
            console.log("Update process completed", JSON.stringify(status));
          })
        }
      />
    </SafeAreaView>
  );
}

export default HotUpdater.wrap({
  source: `${HOT_UPDATER_SUPABASE_URL}/functions/v1/update-server`,
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
