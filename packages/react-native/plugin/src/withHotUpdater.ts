import {
  type ConfigPlugin,
  createRunOncePlugin,
  withAppDelegate,
  withMainApplication,
} from "expo/config-plugins";
import pkg from "../../package.json";

// Type definitions
type HotUpdaterConfig = any;

/**
 * Inserts `importStatement` before `beforeString` if `searchString` is not already present.
 */
function addContentIfNotExists(
  contents: string,
  searchString: string,
  importStatement: string,
  beforeString: string,
): string {
  if (!contents.includes(searchString)) {
    return contents.replace(
      beforeString,
      `${beforeString}\n${importStatement}`,
    );
  }
  return contents;
}

/**
 * Removes all lines containing `target` from the file contents.
 */
function removeAllOccurrences(contents: string, target: string): string {
  return contents
    .split("\n")
    .filter((line) => !line.includes(target))
    .join("\n");
}

const withHotUpdater: ConfigPlugin<HotUpdaterConfig> = (config) => {
  let modifiedConfig = config;

  // === iOS: Objective-C & Swift in AppDelegate ===
  modifiedConfig = withAppDelegate(modifiedConfig, (cfg) => {
    let contents = cfg.modResults.contents;

    // 1) Objective-C: always overwrite import and bundleURL
    contents = removeAllOccurrences(
      contents,
      "#import <HotUpdater/HotUpdater.h>",
    );
    if (contents.includes("#import <React/RCTBundleURLProvider.h>")) {
      contents = addContentIfNotExists(
        contents,
        "#import <HotUpdater/HotUpdater.h>",
        "#import <HotUpdater/HotUpdater.h>",
        '#import "AppDelegate.h"',
      );
      // replace any existing main-bundle return
      contents = contents.replace(
        /\[\[NSBundle mainBundle\] URLForResource:@"main" withExtension:@"jsbundle"\]/g,
        "[HotUpdater bundleURL]",
      );
    }

    // 2) Swift: always overwrite import and bundleURL()
    contents = removeAllOccurrences(contents, "import HotUpdater");
    if (contents.includes("import React")) {
      contents = addContentIfNotExists(
        contents,
        "import HotUpdater",
        "import HotUpdater",
        "import React",
      );
      contents = contents.replace(
        /Bundle\.main\.url\(forResource: "?main"?, withExtension: "jsbundle"\)/g,
        "HotUpdater.bundleURL()",
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });

  // === Android: Kotlin & Java in MainApplication ===
  modifiedConfig = withMainApplication(modifiedConfig, (cfg) => {
    let contents = cfg.modResults.contents;

    // 3) Kotlin: always overwrite import and getJSBundleFile()
    contents = removeAllOccurrences(
      contents,
      "import com.hotupdater.HotUpdater",
    );
    if (contents.includes("object : DefaultReactNativeHost(this) {")) {
      contents = addContentIfNotExists(
        contents,
        "import com.hotupdater.HotUpdater",
        "import com.hotupdater.HotUpdater",
        "import com.facebook.react.ReactApplication",
      );
      // remove any existing getJSBundleFile override
      contents = contents.replace(
        /override fun getJSBundleFile\(\): String\? \{[\s\S]*?\}/g,
        "",
      );
      // insert new override immediately after isHermesEnabled
      contents = contents.replace(
        "override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED",
        `override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED

        override fun getJSBundleFile(): String? {
            return HotUpdater.getJSBundleFile(applicationContext)
        }`,
      );
    }

    // 4) Java: always overwrite import and getJSBundleFile()
    contents = removeAllOccurrences(
      contents,
      "import com.hotupdater.HotUpdater;",
    );
    if (contents.includes("new DefaultReactNativeHost")) {
      contents = addContentIfNotExists(
        contents,
        "import com.hotupdater.HotUpdater;",
        "import com.hotupdater.HotUpdater;",
        "import com.facebook.react.ReactApplication;",
      );
      // remove any existing getJSBundleFile override
      contents = contents.replace(
        /@Override\s+protected String getJSBundleFile\(\)\s*\{[\s\S]*?\}/g,
        "",
      );
      // insert new override immediately after Hermes override
      contents = contents.replace(
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

    cfg.modResults.contents = contents;
    return cfg;
  });

  return modifiedConfig;
};

export default createRunOncePlugin(withHotUpdater, pkg.name, pkg.version);
