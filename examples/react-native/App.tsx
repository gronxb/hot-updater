/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import {
  getAppVersion,
  getBundleVersion,
  init,
  reload,
} from "@hot-updater/react-native";
import type React from "react";
import { Button, SafeAreaView, Text } from "react-native";

init({
  metadata: {
    files: [
      "https://gronxb.s3.ap-northeast-2.amazonaws.com/MhpYhz/index.ios.bundle",
    ],
    id: "MhpYh",
    version: "1.0.0",
    reloadAfterUpdate: true,
  },
  // metadata: async () => {
  //   const metadata = await fetch('https://localhost:3000/metadata').then(res =>
  //     res.json(),
  //   );
  //   console.log('metadata', metadata);
  //   return metadata;
  // },
  onFailure: (error) => {
    console.error("Hot Updater error", error);
  },
  onSuccess: async () => {
    console.log("Hot Updater success");
  },
});

function App(): React.JSX.Element {
  return (
    <SafeAreaView>
      <Text>Hello World</Text>

      <Button title="reload" onPress={() => reload()} />

      <Button
        title="get Version Id"
        onPress={async () => {
          console.log(await getBundleVersion(), await getAppVersion());
        }}
      />
    </SafeAreaView>
  );
}

export default App;