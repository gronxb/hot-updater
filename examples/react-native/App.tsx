/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React from 'react';
import {Button, SafeAreaView, Text} from 'react-native';
import {reload} from '@hot-updater/react-native';

function App(): React.JSX.Element {
  return (
    <SafeAreaView>
      <Text>Hello World</Text>

      <Button title="reload" onPress={() => reload()} />
    </SafeAreaView>
  );
}

export default App;
