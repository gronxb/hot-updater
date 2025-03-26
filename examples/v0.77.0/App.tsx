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

  const progress = useHotUpdaterStore((state) => state.progress);
  return (
    <SafeAreaView>
      <Text>Babel {HotUpdater.getBundleId()}</Text>
      <Text>Channel "{HotUpdater.getChannel()}"</Text>

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
            source: "https://checkupdate-hblmol7y2a-du.a.run.app",
          }).then((status) => {
            console.log("Update process completed", JSON.stringify(status));
          })
        }
      />
    </SafeAreaView>
  );
}

export default HotUpdater.wrap({
  source: "https://checkupdate-hblmol7y2a-du.a.run.app",
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
