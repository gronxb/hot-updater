import fs from "node:fs/promises";
import path from "node:path";

import type { IntegrationDoctorResult } from "@hot-updater/plugin-core";

const ignoredDirectories = new Set([".gradle", "Build", "Pods", "build"]);

const findFiles = async (
  root: string,
  matches: (name: string) => boolean,
): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(path.join(directory, entry.name));
        }
      } else if (entry.isFile() && matches(entry.name)) {
        files.push(path.join(directory, entry.name));
      }
    }
  };
  await visit(root);
  return files.sort();
};

const firstMatchingFile = async (files: string[], patterns: RegExp[]) => {
  for (const file of files) {
    const contents = await fs.readFile(file, "utf8");
    if (patterns.some((pattern) => pattern.test(contents))) return file;
  }
  return null;
};

export const createReactNativeDoctor =
  (cwd: string) => async (): Promise<IntegrationDoctorResult> => {
    const issues: IntegrationDoctorResult["issues"] = [];
    const iosFiles = await findFiles(path.join(cwd, "ios"), (name) =>
      /^AppDelegate\.(?:swift|mm|m)$/.test(name),
    );
    const androidFiles = await findFiles(path.join(cwd, "android"), (name) =>
      /^MainApplication\.(?:kt|java)$/.test(name),
    );
    const iosConfigured =
      iosFiles.length > 0 &&
      (await firstMatchingFile(iosFiles, [
        /HotUpdater\.bundleURL\s*\(/,
        /\[HotUpdater\s+bundleURL(?:WithBundle)?:?/,
      ])) !== null;
    const androidConfigured =
      androidFiles.length > 0 &&
      (await firstMatchingFile(androidFiles, [
        /HotUpdater\s*(?:\.\s*Companion\s*)?\.\s*getJSBundleFile\s*\(/,
      ])) !== null;

    if (iosFiles.length === 0) {
      issues.push({
        type: "error",
        platform: "ios",
        code: "APP_DELEGATE_NOT_FOUND",
        message: "iOS AppDelegate file was not found.",
        resolution:
          "Add HotUpdater.bundleURL() to the app's iOS bundle URL provider.",
        fixability: "auto",
      });
    } else if (!iosConfigured) {
      issues.push({
        type: "error",
        platform: "ios",
        code: "MISSING_IOS_BUNDLE_PROVIDER",
        message: "iOS AppDelegate does not use HotUpdater.bundleURL().",
        resolution:
          "Replace the release JavaScript bundle URL provider with HotUpdater.bundleURL().",
        fixability: "auto",
        paths: iosFiles.map((file) => path.relative(cwd, file)),
      });
    }

    if (androidFiles.length === 0) {
      issues.push({
        type: "error",
        platform: "android",
        code: "MAIN_APPLICATION_NOT_FOUND",
        message: "Android MainApplication file was not found.",
        resolution:
          "Add HotUpdater.getJSBundleFile(applicationContext) to the Android host configuration.",
        fixability: "auto",
      });
    } else if (!androidConfigured) {
      issues.push({
        type: "error",
        platform: "android",
        code: "MISSING_ANDROID_BUNDLE_PROVIDER",
        message:
          "Android MainApplication does not use HotUpdater.getJSBundleFile().",
        resolution:
          "Pass HotUpdater.getJSBundleFile(applicationContext) to the React Native JavaScript bundle provider.",
        fixability: "auto",
        paths: androidFiles.map((file) => path.relative(cwd, file)),
      });
    }

    return {
      issues,
      platforms: {
        ios: {
          configured: iosConfigured,
          files: iosFiles.map((file) => path.relative(cwd, file)),
        },
        android: {
          configured: androidConfigured,
          files: androidFiles.map((file) => path.relative(cwd, file)),
        },
      },
    };
  };
