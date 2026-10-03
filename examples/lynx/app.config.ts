import reactConfig from "./react/lynx.config";
import vueConfig from "./vue/lynx.config";

const framework = process.env.LYNX_FRAMEWORK;
if (framework !== "react" && framework !== "vue") {
  throw new Error("Set LYNX_FRAMEWORK to react or vue for this Sparkling example.");
}

// Shared with a Sparkling host; native shells are the next implementation stage.
export default {
  lynxConfig: framework === "react" ? reactConfig : vueConfig,
  appName: "HotUpdaterLynx",
  platform: {
    android: { packageName: "com.hotupdater.lynxexample" },
    ios: { bundleIdentifier: "com.hotupdater.lynxexample" },
  },
  paths: {
    androidAssets: "android/app/src/main/assets",
    iosAssets: "ios/LynxResources/Assets",
  },
};
