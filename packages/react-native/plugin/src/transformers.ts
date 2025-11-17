/**
 * Pure transformation functions for HotUpdater code injection
 * These utilities handle code transformations for different React Native patterns
 */

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
    return contents;
  }

  // Add lines after the anchor
  return contents.replace(anchor, `${anchor}\n${linesToAdd.join("\n")}`);
}

/**
 * Helper to replace content only if the target content exists and hasn't been replaced yet.
 */
function replaceContentOnce(
  contents: string,
  searchRegex: RegExp,
  replacement: string,
  checkIfAlreadyReplaced: string,
): string {
  // If the replacement content is already present, assume it's done.
  if (contents.includes(checkIfAlreadyReplaced)) {
    return contents;
  }
  // Otherwise, perform the replacement if the search target exists.
  return contents.replace(searchRegex, replacement);
}

/**
 * Transform Android code for RN 0.82+ pattern
 * Injects jsBundleFilePath parameter into getDefaultReactHost()
 */
export function transformAndroidRN082Kotlin(contents: string): string {
  const kotlinImport = "import com.hotupdater.HotUpdater";
  const kotlinImportAnchor = "import com.facebook.react.ReactApplication";
  const kotlinMethodCheck = "HotUpdater.getJSBundleFile(applicationContext)";

  // Detect RN 0.82+ new pattern (getDefaultReactHost with packageList)
  const newPatternKotlinDetector =
    /getDefaultReactHost\s*\(\s*\n?\s*context\s*=\s*applicationContext\s*,\s*\n?\s*packageList\s*=/;
  const hasNewKotlinPattern = newPatternKotlinDetector.test(contents);

  if (!hasNewKotlinPattern) {
    return contents;
  }

  // 1. Add import if missing
  let result = addLinesOnce(contents, kotlinImportAnchor, [kotlinImport]);

  // 2. Check if jsBundleFilePath with HotUpdater is already present
  if (
    result.includes(kotlinMethodCheck) &&
    result.includes("jsBundleFilePath")
  ) {
    return result;
  }

  // Find the getDefaultReactHost closing pattern and add jsBundleFilePath before it
  // Look for the pattern: },<whitespace>)<whitespace>} which is the end of packageList
  const getDefaultReactHostEnd = /(\},\s*)\n(\s*)\)/;

  if (getDefaultReactHostEnd.test(result)) {
    result = result.replace(
      getDefaultReactHostEnd,
      (_match, prefix, closingIndent) => {
        // The jsBundleFilePath should have same indentation as other parameters (2 spaces more than closing paren)
        const paramIndent = `${closingIndent}  `;
        return `${prefix}\n${paramIndent}jsBundleFilePath = HotUpdater.getJSBundleFile(applicationContext),\n${closingIndent})`;
      },
    );
  }

  return result;
}

/**
 * Transform Android code for RN 0.81 and Expo 54 pattern (old pattern)
 * Adds getJSBundleFile() override method to DefaultReactNativeHost
 */
export function transformAndroidOldKotlin(contents: string): string {
  const kotlinImport = "import com.hotupdater.HotUpdater";
  const kotlinImportAnchor = "import com.facebook.react.ReactApplication";
  const kotlinReactNativeHostAnchor = "object : DefaultReactNativeHost(this) {";
  const kotlinMethodCheck = "HotUpdater.getJSBundleFile(applicationContext)";
  const kotlinExistingMethodRegex =
    /^\s*override fun getJSBundleFile\(\): String\?\s*\{[\s\S]*?^\s*\}/gm;
  const kotlinHermesAnchor =
    "override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED";
  const kotlinNewArchAnchor =
    "override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED";

  // Check if this is the old pattern with DefaultReactNativeHost
  if (!contents.includes(kotlinReactNativeHostAnchor)) {
    return contents;
  }

  // 1. Add import if missing
  let result = addLinesOnce(contents, kotlinImportAnchor, [kotlinImport]);

  // 2. Add/Replace getJSBundleFile method if needed
  if (!result.includes(kotlinMethodCheck)) {
    // Remove potentially existing (different) override first
    result = result.replace(kotlinExistingMethodRegex, "");

    // Determine the anchor and its indentation
    let anchorLine = "";
    if (result.includes(kotlinHermesAnchor)) {
      anchorLine = kotlinHermesAnchor;
    } else if (result.includes(kotlinNewArchAnchor)) {
      anchorLine = kotlinNewArchAnchor;
    }

    if (anchorLine) {
      // Find the indentation of the anchor line
      const anchorMatch = result.match(
        new RegExp(
          `^(\\s*)${anchorLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          "m",
        ),
      );
      if (anchorMatch) {
        const indent = anchorMatch[1];

        // Detect indent size by finding object : DefaultReactNativeHost line
        const objectMatch = result.match(
          /^(\s*)object\s*:\s*DefaultReactNativeHost/m,
        );
        let indentSize = 2; // default
        if (objectMatch) {
          const objectIndent = objectMatch[1].length;
          const propertyIndent = indent.length;
          indentSize = propertyIndent - objectIndent;
        }

        // Use consistent 2-space or 4-space indentation based on detected indent size
        const spaces = indentSize === 2 ? "  " : "    ";
        const bodyIndent = indent + spaces;

        // Create method with proper formatting - use \n\n to add blank line before method
        const kotlinNewMethod = `\n\n${indent}override fun getJSBundleFile(): String? {\n${bodyIndent}return HotUpdater.getJSBundleFile(applicationContext)\n${indent}}`;

        result = result.replace(anchorLine, `${anchorLine}${kotlinNewMethod}`);
      }
    } else {
      // Fallback: Add before the closing brace of the object
      const rnHostEndRegex =
        /(\s*object\s*:\s*DefaultReactNativeHost\s*\([\s\S]*?\n)(\s*\})\s*$/m;
      if (rnHostEndRegex.test(result)) {
        const kotlinNewMethod = `\n        override fun getJSBundleFile(): String? {\n          return HotUpdater.getJSBundleFile(applicationContext)\n        }`;
        result = result.replace(rnHostEndRegex, `$1${kotlinNewMethod}\n$2`);
      } else {
        throw new Error(
          "[transformAndroidOldKotlin] Could not find anchor to insert getJSBundleFile.",
        );
      }
    }
  }

  return result;
}

/**
 * Transform iOS Objective-C AppDelegate code
 * Replaces NSBundle bundleURL with HotUpdater bundleURL
 */
export function transformIOSObjectiveC(contents: string): string {
  const iosImport = "#import <HotUpdater/HotUpdater.h>";
  const iosBundleUrl = "[HotUpdater bundleURL]";
  const iosOriginalBundleUrlRegex =
    /\[\[NSBundle mainBundle\] URLForResource:@"main" withExtension:@"jsbundle"\]/g;
  const iosAppDelegateHeader = '#import "AppDelegate.h"';

  // Check if it's likely Obj-C
  if (!contents.includes(iosAppDelegateHeader)) {
    return contents;
  }

  // 1. Add import if missing
  let result = addLinesOnce(contents, iosAppDelegateHeader, [iosImport]);

  // 2. Replace bundleURL provider if the original exists and hasn't been replaced
  result = replaceContentOnce(
    result,
    iosOriginalBundleUrlRegex,
    iosBundleUrl,
    iosBundleUrl,
  );

  return result;
}

/**
 * Transform iOS Swift AppDelegate code
 * Replaces Bundle.main.url with HotUpdater.bundleURL()
 */
export function transformIOSSwift(contents: string): string {
  const swiftImport = "import HotUpdater";
  const swiftBundleUrl = "HotUpdater.bundleURL()";
  const swiftOriginalBundleUrlRegex =
    /Bundle\.main\.url\(forResource: "?main"?, withExtension: "jsbundle"\)/g;

  // Check if it's likely Swift (look for import statements)
  if (!contents.includes("import ")) {
    return contents;
  }

  // 1. Add import if missing - find the last import statement and add after it
  let result = contents;
  if (!result.includes(swiftImport)) {
    // Find the last import statement
    const lastImportMatch = result.match(/^import .*$/gm);
    if (lastImportMatch) {
      const lastImport = lastImportMatch[lastImportMatch.length - 1];
      result = result.replace(lastImport, `${lastImport}\n${swiftImport}`);
    }
  }

  // 2. Replace bundleURL provider if the original exists and hasn't been replaced
  result = replaceContentOnce(
    result,
    swiftOriginalBundleUrlRegex,
    swiftBundleUrl,
    swiftBundleUrl,
  );

  return result;
}
