import React from 'react';
import { Text, View } from 'react-native';

import { cardStyles } from './cardStyles';

type Props = {
  host?: string;
};

export function NativeHostCard({ host }: Props) {
  return (
    <View style={cardStyles.card}>
      <Text style={cardStyles.title}>Hello from React Native</Text>
      <Text style={cardStyles.body}>
        This screen is a React Native root view pushed full-screen by the native
        host. The JavaScript bundle ships inside the RnBrownfieldReact
        XCFramework and the rnbrownfieldreact AAR.
      </Text>
      <Text style={cardStyles.body}>
        The back button above calls popToNative(), which pops this screen off
        the host's native navigation stack.
      </Text>
      <Text style={cardStyles.meta}>Host: {host ?? 'unknown'}</Text>
    </View>
  );
}
