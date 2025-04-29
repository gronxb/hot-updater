import { platformAndroid } from "@rnef/platform-android";
import { platformIOS } from "@rnef/platform-ios";
import { pluginRepack } from "@rnef/plugin-repack";

export default {
  bundler: pluginRepack(),
  platforms: {
    ios: platformIOS(),
    android: platformAndroid(),
  },
  remoteCacheProvider: null,
};
