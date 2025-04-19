import type { ExpoConfig } from "expo/config";
import {
  type ConfigPlugin,
  createRunOncePlugin,
  withAppDelegate,
  withMainApplication,
} from "expo/config-plugins";
import pkg from "../../package.json";

// Type definitions
type HotUpdaterConfig = any;

// Interface for string resources
interface StringResources {
  string: Array<{
    $: { name: string };
    _: string;
  }>;
}

// Utility function to add string resource
const addStringResource = (
  resources: StringResources,
  name: string,
  value: string,
) => {
  resources.string = resources.string || [];
  resources.string.push({
    $: { name },
    _: value,
  });
};

// Utility function to add content if not exists
const addContentIfNotExists = (
  contents: string,
  searchString: string,
  importStatement: string,
  beforeString: string,
) => {
  if (!contents.includes(searchString)) {
    return contents.replace(
      beforeString,
      `${beforeString}\n${importStatement}`,
    );
  }
  return contents;
};

const withHotUpdater: ConfigPlugin<HotUpdaterConfig> = (
  config: ExpoConfig,
  options: HotUpdaterConfig = {},
) => {
  let modifiedConfig = config;
  // Configure iOS AppDelegate.mm
  modifiedConfig = withAppDelegate(modifiedConfig, (config) => {
    // #import <React/RCTBundleURLProvider.h>
    if (
      config.modResults.contents.includes(
        "#import <React/RCTBundleURLProvider.h>",
      )
    ) {
      config.modResults.contents = addContentIfNotExists(
        config.modResults.contents,
        "#import <HotUpdater/HotUpdater.h>",
        "#import <HotUpdater/HotUpdater.h>",
        '#import "AppDelegate.h"',
      );
      if (!config.modResults.contents.includes("[HotUpdater bundleURL]")) {
        config.modResults.contents = config.modResults.contents.replace(
          'return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];',
          "return [HotUpdater bundleURL];",
        );
      }
    }

    // import React
    if (config.modResults.contents.includes("import React")) {
      config.modResults.contents = addContentIfNotExists(
        config.modResults.contents,
        "import React",
        "import React",
        "import HotUpdater",
      );
      if (!config.modResults.contents.includes("HotUpdater.bundleURL()")) {
        config.modResults.contents = config.modResults.contents.replace(
          `Bundle.main.url(forResource: "main", withExtension: "jsbundle")`,
          "HotUpdater.bundleURL()",
        );
      }
    }
    return config;
  });

  modifiedConfig = withMainApplication(modifiedConfig, (config) => {
    //kt: object : DefaultReactNativeHost(this) {
    if (config.modResults.contents.includes("new DefaultReactNativeHost")) {
      config.modResults.contents = addContentIfNotExists(
        config.modResults.contents,
        "import com.hotupdater.HotUpdater",
        "import com.hotupdater.HotUpdater",
        "import com.facebook.react.ReactApplication",
      );

      if (
        !config.modResults.contents.includes(
          "override fun getJSBundleFile(): String",
        )
      ) {
        config.modResults.contents = config.modResults.contents.replace(
          "override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED",
          `override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED

          override fun getJSBundleFile(): String? {  
            return HotUpdater.getJSBundleFile(applicationContext)  
          }`,
        );
      }
    }
    // java: new DefaultReactNativeHost(this) {
    if (config.modResults.contents.includes("new DefaultReactNativeHost")) {
      config.modResults.contents = addContentIfNotExists(
        config.modResults.contents,
        "import com.hotupdater.HotUpdater;",
        "import com.hotupdater.HotUpdater;",
        "import com.facebook.react.ReactApplication;",
      );
      if (
        config.modResults.contents.includes(
          "protected String getJSBundleFile()",
        )
      ) {
        config.modResults.contents = config.modResults.contents.replace(
          `@Override
        protected Boolean isHermesEnabled() {
          return BuildConfig.IS_HERMES_ENABLED;
        }`,
          `@Override
        protected Boolean isHermesEnabled() {
          return BuildConfig.IS_HERMES_ENABLED;
        }
        @Override 
        protected String getJSBundleFile() {  
            return HotUpdater.Companion.getJSBundleFile(this.getApplication().getApplicationContext());  
        }`,
        );
      }
    }
    return config;
  });

  return modifiedConfig;
};

export default createRunOncePlugin(withHotUpdater, pkg.name, pkg.version);
