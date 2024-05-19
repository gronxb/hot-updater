/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React from 'react';
import {Button, SafeAreaView, Text} from 'react-native';
import {reload, init, getAppVersionId} from '@hot-updater/react-native';

init({
  // metadata: {
  //   files: [
  //     'https://gronxb.s3.ap-northeast-2.amazonaws.com/MhpYhz/assets/node_modules/.pnpm/react-native@0.72.6_@babel+core@7.23.2_@babel+preset-env@7.23.2_react@18.2.0/node_modules/react-native/Libraries/LogBox/UI/LogBoxImages/alert-triangle.png',
  //     'https://gronxb.s3.ap-northeast-2.amazonaws.com/MhpYhz/assets/node_modules/.pnpm/react-native@0.72.6_@babel+core@7.23.2_@babel+preset-env@7.23.2_react@18.2.0/node_modules/react-native/Libraries/LogBox/UI/LogBoxImages/chevron-left.png',
  //     'https://gronxb.s3.ap-northeast-2.amazonaws.com/MhpYhz/assets/node_modules/.pnpm/react-native@0.72.6_@babel+core@7.23.2_@babel+preset-env@7.23.2_react@18.2.0/node_modules/react-native/Libraries/LogBox/UI/LogBoxImages/chevron-right.png',
  //     'https://gronxb.s3.ap-northeast-2.amazonaws.com/MhpYhz/assets/node_modules/.pnpm/react-native@0.72.6_@babel+core@7.23.2_@babel+preset-env@7.23.2_react@18.2.0/node_modules/react-native/Libraries/LogBox/UI/LogBoxImages/close.png',
  //     'https://gronxb.s3.ap-northeast-2.amazonaws.com/MhpYhz/assets/node_modules/.pnpm/react-native@0.72.6_@babel+core@7.23.2_@babel+preset-env@7.23.2_react@18.2.0/node_modules/react-native/Libraries/LogBox/UI/LogBoxImages/loader.png',
  //     'https://gronxb.s3.ap-northeast-2.amazonaws.com/MhpYhz/assets/src/logo.png',
  //     'https://gronxb.s3.ap-northeast-2.amazonaws.com/MhpYhz/index.bundle',
  //     'https://gronxb.s3.ap-northeast-2.amazonaws.com/MhpYhz/index.bundle.map',
  //   ],
  //   id: 'MhpYhz',
  //   version: '1.0.0',
  //   reloadAfterUpdate: true,
  // },
  metadata: async () => {
    return fetch('https://localhost:3000/metadata').then(res => res.json());
  },
  onFailure: error => {
    console.error('Hot Updater error', error);
  },
  onSuccess: async () => {
    console.log('Hot Updater success');
    console.log('AA', await getAppVersionId());
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
          console.log('AA', await getAppVersionId());
        }}
      />
    </SafeAreaView>
  );
}

export default App;
