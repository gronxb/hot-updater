import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { transformAndroid, transformIOS } from "@hot-updater/native-patches";

import { HOT_UPDATER_PATCH, type HotUpdaterPatchesOptions } from "./tag";

export type { HotUpdaterPatchesOptions } from "./tag";

/**
 * One's `NativeAppPatch`: an edit `one prebuild` runs on one generated native
 * file. Declared here so this entry loads without `one`'s types.
 */
export interface OneNativeAppPatch {
  platform: "ios" | "android";
  /** A path suffix that matches exactly one generated file. */
  file: string;
  /** Returns the new contents; returns its input when the edit is there. */
  patch: (content: string) => string;
}

const IOS_CHANNEL_KEY = "HOT_UPDATER_CHANNEL";
const IOS_PUBLIC_KEY_KEY = "HOT_UPDATER_PUBLIC_KEY";
const IOS_FINGERPRINT_HASH_KEY = "HOT_UPDATER_FINGERPRINT_HASH";
const ANDROID_CHANNEL_KEY = "com.hotupdater.CHANNEL";
const ANDROID_PUBLIC_KEY_KEY = "com.hotupdater.PUBLIC_KEY";
const ANDROID_FINGERPRINT_HASH_KEY = "com.hotupdater.FINGERPRINT_HASH";

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An Android string resource value, escaped as `expo/config-plugins`'
 * `XML.escapeAndroidString` escapes it, so the manifest holds what the Expo
 * config plugin writes.
 */
const escapeAndroidString = (value: string) => {
  const escaped = value.replace(/[\n\r\t'"@]/g, (character) => {
    switch (character) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return `\\${character}`;
    }
  });
  return /(^\s|\s$)/.test(escaped) ? `"${escaped}"` : escaped;
};

const missingAnchor = (file: string, anchor: string): never => {
  throw new Error(
    `[hot-updater] cannot patch ${file}: expected ${anchor} in it. Leave native.app.updates unset, or update @hot-updater/one.`,
  );
};

/** Removes `key` and its value from the plist's top-level dict. */
const removePlistKey = (content: string, key: string) =>
  content.replace(
    new RegExp(
      `\\n?[ \\t]*<key>${escapeRegExp(key)}</key>\\s*<string>[^<]*</string>`,
      "g",
    ),
    "",
  );

/** Sets `key` to `value` in the plist's top-level dict. */
const setPlistString = (content: string, key: string, value: string) => {
  const removed = removePlistKey(content, key);
  const root = /<plist[^>]*>\s*<dict>/.exec(removed);
  if (root === null) return missingAnchor("Info.plist", "<plist><dict>");
  const at = root.index + root[0].length;
  return `${removed.slice(0, at)}\n\t<key>${key}</key>\n\t<string>${escapeXml(value)}</string>${removed.slice(at)}`;
};

/** Removes the `<meta-data>` named `name` from the manifest. */
const removeMetaData = (content: string, name: string) =>
  content.replace(
    new RegExp(
      `\\n?[ \\t]*<meta-data\\b[^>]*android:name="${escapeRegExp(name)}"[^>]*/>`,
      "g",
    ),
    "",
  );

/** Sets the `<meta-data>` named `name` in the manifest's application. */
const setMetaData = (content: string, name: string, value: string) => {
  const removed = removeMetaData(content, name);
  const end = /\n?([ \t]*)<\/application>/.exec(removed);
  if (end === null) {
    return missingAnchor("AndroidManifest.xml", "</application>");
  }
  const indent = `${end[1]}  `;
  return `${removed.slice(0, end.index)}\n${indent}<meta-data android:name="${name}" android:value="${escapeXml(value)}"/>${removed.slice(end.index)}`;
};

/**
 * The SPKI PEM in `publicKeyPath`, checked as the CLI checks a bundle signing
 * public key: an RSA key of at least 2048 bits.
 */
const readPublicKey = (cwd: string, publicKeyPath: string): string => {
  let pem: string;
  try {
    pem = fs.readFileSync(path.resolve(cwd, publicKeyPath), "utf8").trim();
  } catch {
    throw new Error(
      `[hot-updater] cannot read the bundle signing public key file ${publicKeyPath}.`,
    );
  }
  let key: crypto.KeyObject | undefined;
  try {
    if (
      pem.startsWith("-----BEGIN PUBLIC KEY-----") &&
      pem.endsWith("-----END PUBLIC KEY-----")
    ) {
      key = crypto.createPublicKey(pem);
    }
  } catch {
    key = undefined;
  }
  if (
    key === undefined ||
    key.asymmetricKeyType !== "rsa" ||
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new Error(
      `[hot-updater] ${publicKeyPath} must be an RSA SPKI PEM public key of at least 2048 bits.`,
    );
  }
  return key.export({ type: "spki", format: "pem" }).toString().trim();
};

/**
 * The `native.app.patches` entries that set up Hot Updater in the native
 * files `one prebuild` generates: the AppDelegate and MainApplication load
 * Hot Updater's bundle, and Info.plist and AndroidManifest.xml carry the
 * channel and, with `publicKeyPath`, the bundle signing public key.
 *
 * @example
 * ```ts
 * import { hotUpdaterPatches } from "@hot-updater/one/patches";
 *
 * one({
 *   native: {
 *     app: {
 *       patches: hotUpdaterPatches({ channel: "production" }),
 *     },
 *   },
 * });
 * ```
 */
export const hotUpdaterPatches = (
  options: HotUpdaterPatchesOptions = {},
): OneNativeAppPatch[] => {
  const { publicKeyPath } = options;
  if (
    publicKeyPath !== undefined &&
    (typeof publicKeyPath !== "string" || !publicKeyPath.trim())
  ) {
    throw new Error("[hot-updater] publicKeyPath must be a non-empty path.");
  }
  const channel = options.channel || "production";
  // One loads the vite config from the app root, and prebuild runs there.
  const cwd = process.cwd();
  // Read once, when prebuild first patches, so `one dev` needs no key file.
  let publicKey: string | undefined;
  const getPublicKey = (file: string) => {
    publicKey ??= readPublicKey(cwd, file);
    return publicKey;
  };

  const patches: OneNativeAppPatch[] = [
    {
      platform: "ios",
      file: "AppDelegate.swift",
      patch: (content) => {
        const patched = transformIOS(content);
        return patched.includes("HotUpdater.bundleURL()")
          ? patched
          : missingAnchor(
              "AppDelegate.swift",
              'Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
            );
      },
    },
    {
      platform: "ios",
      file: "Info.plist",
      patch: (content) => {
        let patched = setPlistString(content, IOS_CHANNEL_KEY, channel);
        patched = removePlistKey(patched, IOS_FINGERPRINT_HASH_KEY);
        return publicKeyPath === undefined
          ? removePlistKey(patched, IOS_PUBLIC_KEY_KEY)
          : setPlistString(
              patched,
              IOS_PUBLIC_KEY_KEY,
              getPublicKey(publicKeyPath),
            );
      },
    },
    {
      platform: "android",
      file: "MainApplication.kt",
      patch: (content) => {
        const patched = transformAndroid(content);
        return patched.includes("HotUpdater.getJSBundleFile")
          ? patched
          : missingAnchor("MainApplication.kt", "getDefaultReactHost(");
      },
    },
    {
      platform: "android",
      file: "main/AndroidManifest.xml",
      patch: (content) => {
        let patched = setMetaData(content, ANDROID_CHANNEL_KEY, channel);
        patched = removeMetaData(patched, ANDROID_FINGERPRINT_HASH_KEY);
        return publicKeyPath === undefined
          ? removeMetaData(patched, ANDROID_PUBLIC_KEY_KEY)
          : setMetaData(
              patched,
              ANDROID_PUBLIC_KEY_KEY,
              escapeAndroidString(getPublicKey(publicKeyPath)),
            );
      },
    },
  ];
  const tag = {
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    ...(publicKeyPath === undefined ? {} : { publicKeyPath }),
  };
  return patches.map((patch) =>
    Object.defineProperty(patch, HOT_UPDATER_PATCH, { value: tag }),
  );
};
