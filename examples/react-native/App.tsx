/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import { HotUpdater } from "@hot-updater/react-native";
import type React from "react";
import { useEffect, useState } from "react";
import { Button, Image, SafeAreaView, Text } from "react-native";

HotUpdater.init({
  payload: async () => {
    const payload = await fetch("").then((res) => res.json());
    return payload;
  },
  onError: (e) => {
    console.error("Hot Updater error", e);
  },
  onSuccess: async (status) => {
    console.log("Hot Updater success", status);
  },
});

function App(): React.JSX.Element {
  const [version, setVersion] = useState<number | null>(null);

  useEffect(() => {
    HotUpdater.getBundleVersion().then((version) => {
      setVersion(version);
    });
  }, []);

  return (
    <SafeAreaView>
      <Image
        source={require("./src/logo.png")}
        style={{
          marginTop: 20,
          width: "100%",
          height: "50%",
        }}
        resizeMode="center"
      />

      <Text
        style={{
          marginVertical: 20,
          fontSize: 20,
          fontWeight: "bold",
          textAlign: "center",
        }}
      >
        Hot Updater UP_TO_DATE !
      </Text>
      <Text
        style={{
          marginVertical: 20,
          fontSize: 20,
          fontWeight: "bold",
          textAlign: "center",
        }}
      >
        Bundle Version: {version ?? "Loading..."}
      </Text>

      <Button title="Reload" onPress={() => HotUpdater.reload()} />
    </SafeAreaView>
  );
}

export default App;
