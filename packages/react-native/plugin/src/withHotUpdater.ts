import {
  type ConfigPlugin,
  createRunOncePlugin,
  withAppDelegate,
  withMainApplication,
} from "expo/config-plugins";
import pkg from "../../package.json";

// Type definitions (Assuming HotUpdaterConfig might be used later)
type HotUpdaterConfig = Record<string, unknown>; // Allow no props

/**
 * Helper to add lines if they don't exist, anchored by a specific string.
 */
function addLinesOnce(
  contents: string,
  anchor: string,
  linesToAdd: string[],
): string {
  if (linesToAdd.every((line) => contents.includes(line))) {
    // All lines already exist, do nothing
    return contents;
  }

  // Check if the anchor exists
  if (!contents.includes(anchor)) {
    // Anchor not found, cannot add lines reliably.
    // Consider logging a warning or throwing an error here if necessary.
    return contents;
  }

  // Add lines after the anchor
  // Ensure newline separation
  return contents.replace(anchor, `${anchor}\n${linesToAdd.join("\n")}`);
}

/**
 * Helper to replace content only if the target content exists and hasn't been replaced yet.
 */
function replaceContentOnce(
  contents: string,
  searchRegex: RegExp,
  replacement: string,
  checkIfAlreadyReplaced: string, // A string unique to the replacement
): string {
  // If the replacement content is already present, assume it's done.
  if (contents.includes(checkIfAlreadyReplaced)) {
    return contents;
  }
  // Otherwise, perform the replacement if the search target exists.
  return contents.replace(searchRegex, replacement);
}

const withHotUpdater: ConfigPlugin<HotUpdaterConfig> = (config) => {
  let modifiedConfig = config;

  // === iOS: Objective-C & Swift in AppDelegate ===
  modifiedConfig = withAppDelegate(modifiedConfig, (cfg) => {
    let contents = cfg.modResults.contents;
    const iosImport = "#import <HotUpdater/HotUpdater.h>";
    const iosBundleUrl = "[HotUpdater bundleURL]";
    const iosOriginalBundleUrlRegex =
      /\[\[NSBundle mainBundle\] URLForResource:@"main" withExtension:@"jsbundle"\]/g;
    const iosAppDelegateHeader = '#import "AppDelegate.h"'; // Anchor for import

    const swiftImport = "import HotUpdater";
    const swiftBundleUrl = "HotUpdater.bundleURL()";
    const swiftOriginalBundleUrlRegex =
      /Bundle\.main\.url\(forResource: "?main"?, withExtension: "jsbundle"\)/g;
    const swiftReactImport = "import React"; // Anchor for import

    // --- Objective-C ---
    if (contents.includes(iosAppDelegateHeader)) {
      // Check if it's likely Obj-C
      // 1. Add import if missing
      contents = addLinesOnce(contents, iosAppDelegateHeader, [iosImport]);

      // 2. Replace bundleURL provider if the original exists and hasn't been replaced
      contents = replaceContentOnce(
        contents,
        iosOriginalBundleUrlRegex,
        iosBundleUrl,
        iosBundleUrl, // Check using the replacement itself
      );
    }

    // --- Swift ---
    if (contents.includes(swiftReactImport)) {
      // Check if it's likely Swift
      // 1. Add import if missing
      contents = addLinesOnce(contents, swiftReactImport, [swiftImport]);

      // 2. Replace bundleURL provider if the original exists and hasn't been replaced
      contents = replaceContentOnce(
        contents,
        swiftOriginalBundleUrlRegex,
        swiftBundleUrl,
        swiftBundleUrl, // Check using the replacement itself
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });

  // === Android: Kotlin & Java in MainApplication ===
  modifiedConfig = withMainApplication(modifiedConfig, (cfg) => {
    let contents = cfg.modResults.contents;

    const kotlinImport = "import com.hotupdater.HotUpdater";
    const kotlinImportAnchor = "import com.facebook.react.ReactApplication";
    const kotlinReactNativeHostAnchor =
      "object : DefaultReactNativeHost(this) {"; // Start of block
    const kotlinMethodCheck = "HotUpdater.getJSBundleFile(applicationContext)"; // Unique part of the method body
    // Regex to find an existing getJSBundleFile override (non-greedy)
    const kotlinExistingMethodRegex =
      /^\s*override fun getJSBundleFile\(\): String\?\s*\{[\s\S]*?^\s*\}/gm;
    const kotlinHermesAnchor =
      "override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED";
    const kotlinNewMethod = `
          override fun getJSBundleFile(): String? {
              return HotUpdater.getJSBundleFile(applicationContext)
          }`;

    const javaImport = "import com.hotupdater.HotUpdater;";
    const javaImportAnchor = "import com.facebook.react.ReactApplication;";
    const javaReactNativeHostAnchor = "new DefaultReactNativeHost"; // Part of the instantiation
    const javaMethodCheck = "HotUpdater.Companion.getJSBundleFile"; // Unique part of the method body
    const javaMethodSignature = "protected String getJSBundleFile()";
    // Regex to find an existing getJSBundleFile override (non-greedy)
    const javaExistingMethodRegex =
      /^\s*@Override\s+protected String getJSBundleFile\(\)\s*\{[\s\S]*?^\s*\}/gm;
    const javaHermesBlockEndAnchor = `return BuildConfig.IS_HERMES_ENABLED;
        }`; // End of the isHermesEnabled method block
    const javaNewMethod = `
        @Override
        protected String getJSBundleFile() {
            return HotUpdater.Companion.getJSBundleFile(this.getApplication().getApplicationContext());
        }`;

    // --- Kotlin ---
    if (contents.includes(kotlinReactNativeHostAnchor)) {
      // Check if likely Kotlin
      // 1. Add import if missing
      contents = addLinesOnce(contents, kotlinImportAnchor, [kotlinImport]);

      // 2. Add/Replace getJSBundleFile method if needed
      if (!contents.includes(kotlinMethodCheck)) {
        // Desired method content not found
        // Remove potentially existing (different) override first
        contents = contents.replace(kotlinExistingMethodRegex, "");

        // Add the new method after the isHermesEnabled property
        if (contents.includes(kotlinHermesAnchor)) {
          contents = contents.replace(
            kotlinHermesAnchor,
            `${kotlinHermesAnchor}\n${kotlinNewMethod}`,
          );
        } else {
          // Fallback: Add before the closing brace of the object if anchor not found
          const rnHostEndRegex =
            /(\s*object\s*:\s*DefaultReactNativeHost\s*\([\s\S]*?\n)(\s*\})\s*$/m;
          if (rnHostEndRegex.test(contents)) {
            contents = contents.replace(
              rnHostEndRegex,
              `$1${kotlinNewMethod}\n$2`,
            );
            throw new Error(
              "[withHotUpdater] Kotlin: Could not find Hermes anchor. Added getJSBundleFile before closing brace.",
            );
          }
          throw new Error(
            "[withHotUpdater] Kotlin: Could not find Hermes anchor or closing brace to insert getJSBundleFile.",
          );
        }
      }
    }

    // --- Java ---
    if (
      contents.includes(javaReactNativeHostAnchor) &&
      contents.includes("@Override")
    ) {
      // Check if likely Java
      // 1. Add import if missing
      contents = addLinesOnce(contents, javaImportAnchor, [javaImport]);

      // 2. Add/Replace getJSBundleFile method if needed
      if (!contents.includes(javaMethodCheck)) {
        // Desired method content not found
        // Remove potentially existing (different) override first
        contents = contents.replace(javaExistingMethodRegex, "");

        // Add the new method after the isHermesEnabled method block
        if (contents.includes(javaHermesBlockEndAnchor)) {
          contents = contents.replace(
            javaHermesBlockEndAnchor,
            `${javaHermesBlockEndAnchor}\n${javaNewMethod}`,
          );
        } else {
          // Fallback: Add before the closing brace of the anonymous class
          const rnHostEndRegex =
            /(\s*new\s*DefaultReactNativeHost\s*\([\s\S]*?\n)(\s*\});\s*$/m;
          if (rnHostEndRegex.test(contents)) {
            contents = contents.replace(
              rnHostEndRegex,
              `$1${javaNewMethod}\n$2`,
            );
            throw new Error(
              "[withHotUpdater] Java: Could not find Hermes anchor. Added getJSBundleFile before closing brace.",
            );
          }
          throw new Error(
            "[withHotUpdater] Java: Could not find Hermes anchor or closing brace to insert getJSBundleFile.",
          );
        }
      }
    }

    cfg.modResults.contents = contents;
    return cfg;
  });

  return modifiedConfig;
};

// Export the plugin using createRunOncePlugin for idempotency at the plugin level
export default createRunOncePlugin(withHotUpdater, pkg.name, pkg.version);
