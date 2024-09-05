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

function App(): React.JSX.Element {
  const [version, setVersion] = useState<number | null>(null);

  useEffect(() => {
    HotUpdater.getBundleVersion().then((version) => {
      setVersion(version);
    });
  }, []);

  return (
    <SafeAreaView>
      <Text
        style={{
          marginVertical: 20,
          fontSize: 20,
          fontWeight: "bold",
          textAlign: "center",
        }}
      >
        Hot Updater 14
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

      <Image
        source={require("./src/test/_image.png")}
        style={{ width: 200, height: 200, alignSelf: "center" }}
      />

      <Button title="Reload" onPress={() => HotUpdater.reload()} />
    </SafeAreaView>
  );
}

export default App;
