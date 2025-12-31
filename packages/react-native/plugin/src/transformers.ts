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
 * Android: handle getDefaultReactHost pattern (RN 0.82+ style).
 * Adds jsBundleFilePath parameter to the call.
 */
function transformAndroidReactHost(contents: string): string {
  const kotlinImport = "import com.hotupdater.HotUpdater";
  const kotlinImportAnchor = "import com.facebook.react.ReactApplication";
  const kotlinMethodCheck = "HotUpdater.getJSBundleFile(applicationContext)";

  // Quick pattern detection: only touch files using getDefaultReactHost
  // with the new RN 0.82+ parameter style.
  if (
    !contents.includes("getDefaultReactHost(") ||
    !contents.includes("packageList =")
  ) {
    return contents;
  }

  // 1. Ensure HotUpdater import exists (idempotent via addLinesOnce)
  const result = addLinesOnce(contents, kotlinImportAnchor, [kotlinImport]);

  // 2. If jsBundleFilePath is already wired to HotUpdater, do nothing
  if (
    result.includes(kotlinMethodCheck) &&
    result.includes("jsBundleFilePath")
  ) {
    return result;
  }

  const lines = result.split("\n");

  const callIndex = lines.findIndex((line) =>
    line.includes("getDefaultReactHost("),
  );
  if (callIndex === -1) {
    return result;
  }

  // Determine the indentation used for parameters (e.g. "      ")
  let paramIndent = "";
  for (let i = callIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.startsWith(")")) {
      // No parameters detected, give up safely.
      return result;
    }
    const indentMatch = line.match(/^(\s*)/);
    paramIndent = indentMatch ? indentMatch[1] : "";
    break;
  }

  if (!paramIndent) {
    return result;
  }

  // Find the closing line of the call (a line that is just ")" with indentation).
  let closingIndex = -1;
  for (let i = callIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === ")") {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return result;
  }

  // Avoid inserting twice if jsBundleFilePath already added somewhere in the call.
  for (let i = callIndex; i < closingIndex; i += 1) {
    if (lines[i].includes("jsBundleFilePath")) {
      return result;
    }
  }

  const jsBundleLine = `${paramIndent}jsBundleFilePath = HotUpdater.getJSBundleFile(applicationContext),`;

  lines.splice(closingIndex, 0, jsBundleLine);

  return lines.join("\n");
}

/**
 * Android: DefaultReactNativeHost pattern (RN 0.81 / Expo 54).
 * Adds getJSBundleFile() override to the host.
 */
function transformAndroidDefaultHost(contents: string): string {
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

    const lines = result.split("\n");

    const findLineIndex = (needle: string) => {
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(needle)) {
          return i;
        }
      }
      return -1;
    };

    // Prefer inserting after Hermes line, then after new architecture line
    let anchorIndex = findLineIndex(kotlinHermesAnchor);
    if (anchorIndex === -1) {
      anchorIndex = findLineIndex(kotlinNewArchAnchor);
    }

    if (anchorIndex !== -1) {
      const indentMatch = lines[anchorIndex].match(/^\s*/);
      const indent = indentMatch ? indentMatch[0] : "";

      const objectLine = lines.find((line) =>
        line.includes("object : DefaultReactNativeHost"),
      );
      let indentSize = 2;
      if (objectLine) {
        const objectIndent = (objectLine.match(/^\s*/)?.[0] || "").length;
        const propertyIndent = indent.length;
        const diff = propertyIndent - objectIndent;
        if (diff > 0) {
          indentSize = diff;
        }
      }
      const spaces = indentSize === 2 ? "  " : "    ";
      const bodyIndent = indent + spaces;

      const methodLines = [
        "", // blank line
        `${indent}override fun getJSBundleFile(): String? {`,
        `${bodyIndent}return HotUpdater.getJSBundleFile(applicationContext)`,
        `${indent}}`,
      ];

      const insertIndex = anchorIndex + 1;
      lines.splice(insertIndex, 0, ...methodLines);
      result = lines.join("\n");
    } else {
      // Fallback: insert before the closing brace of the object block
      const hostStartIndex = lines.findIndex((line) =>
        line.includes("object : DefaultReactNativeHost"),
      );

      if (hostStartIndex === -1) {
        throw new Error(
          "[transformAndroidDefaultHost] Could not find DefaultReactNativeHost block.",
        );
      }

      let hostEndIndex = -1;
      for (let i = lines.length - 1; i > hostStartIndex; i -= 1) {
        if (lines[i].trim() === "}") {
          hostEndIndex = i;
          break;
        }
      }

      if (hostEndIndex === -1) {
        throw new Error(
          "[transformAndroidDefaultHost] Could not find end of DefaultReactNativeHost block.",
        );
      }

      const indentMatch = lines[hostEndIndex].match(/^\s*/);
      const indent = indentMatch ? indentMatch[0] : "";
      const bodyIndent = `${indent}  `;

      const methodLines = [
        `${indent}override fun getJSBundleFile(): String? {`,
        `${bodyIndent}return HotUpdater.getJSBundleFile(applicationContext)`,
        `${indent}}`,
      ];

      lines.splice(hostEndIndex, 0, ...methodLines);
      result = lines.join("\n");
    }
  }

  return result;
}

/**
 * Public Android transformer that applies all Android-specific transforms.
 */
export function transformAndroid(contents: string): string {
  let result = contents;
  result = transformAndroidReactHost(result);
  result = transformAndroidDefaultHost(result);
  return result;
}

/**
 * iOS: Objective-C AppDelegate transformation.
 * Replaces NSBundle-based bundleURL with HotUpdater bundleURL.
 */
function transformIOSObjC(contents: string): string {
  const iosImport = "#import <HotUpdater/HotUpdater.h>";
  const iosBundleUrl = "[HotUpdater bundleURL]";
  const iosOriginalBundleUrlRegex =
    /\[\[NSBundle mainBundle\] URLForResource:@"main" withExtension:@"jsbundle"\]/g;
  const iosAppDelegateHeader = '#import "AppDelegate.h"';

  // Check if it's likely Obj-C
  if (!contents.includes(iosAppDelegateHeader)) {
    return contents;
  }

  let result = contents;

  // 1. Ensure HotUpdater import is present
  if (!result.includes(iosImport)) {
    result = addLinesOnce(result, iosAppDelegateHeader, [iosImport]);
  }

  // 2. Swap NSBundle-based URL with HotUpdater bundleURL, but only once
  if (
    !result.includes(iosBundleUrl) &&
    iosOriginalBundleUrlRegex.test(result)
  ) {
    result = result.replace(iosOriginalBundleUrlRegex, iosBundleUrl);
  }

  return result;
}

/**
 * iOS: Swift / Expo AppDelegate transformation.
 * Replaces Bundle.main.url-based bundleURL with HotUpdater.bundleURL().
 */
function transformIOSSwift(contents: string): string {
  const swiftImport = "import HotUpdater";
  const swiftBundleUrl = "HotUpdater.bundleURL()";
  const swiftOriginalBundleUrlRegex =
    /Bundle\.main\.url\(forResource: "?main"?, withExtension: "jsbundle"\)/g;

  // Check if it's likely Swift AppDelegate code
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
  if (
    !result.includes(swiftBundleUrl) &&
    swiftOriginalBundleUrlRegex.test(result)
  ) {
    result = result.replace(swiftOriginalBundleUrlRegex, swiftBundleUrl);
  }

  return result;
}

/**
 * Public iOS transformer that applies both Objective-C and Swift transforms.
 */
export function transformIOS(contents: string): string {
  let result = contents;
  result = transformIOSObjC(result);
  result = transformIOSSwift(result);
  return result;
}
