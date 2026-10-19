import fs from "fs";
import os from "os";
import path from "path";

import { p } from "@hot-updater/cli-tools";
import { execa } from "execa";
import JSZip from "jszip";

const CHANNEL_META_DATA_KEY = "com.hotupdater.CHANNEL";

/** The SDK Gradle builds with: the environment's, or local.properties'. */
const findAndroidSdk = (androidProjectPath: string): string | undefined => {
  const fromEnv =
    process.env["ANDROID_HOME"] || process.env["ANDROID_SDK_ROOT"];
  if (fromEnv) {
    return fromEnv;
  }
  const localProperties = path.join(androidProjectPath, "local.properties");
  if (!fs.existsSync(localProperties)) {
    return undefined;
  }
  const sdkDir = fs
    .readFileSync(localProperties, "utf-8")
    .match(/^sdk\.dir=(.*)$/m)?.[1];
  // local.properties escapes `:` and `\` as Java properties do.
  return sdkDir?.trim().replace(/\\(.)/g, "$1");
};

const compareVersions = (a: string, b: string) => {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

/** The newest build-tools' aapt2, which reads the artifact Gradle wrote. */
const findAapt2 = (androidProjectPath: string): string | undefined => {
  const sdk = findAndroidSdk(androidProjectPath);
  const buildTools = sdk && path.join(sdk, "build-tools");
  if (!buildTools || !fs.existsSync(buildTools)) {
    return undefined;
  }
  const executable = process.platform.startsWith("win") ? "aapt2.exe" : "aapt2";
  return fs
    .readdirSync(buildTools)
    .sort(compareVersions)
    .reverse()
    .map((version) => path.join(buildTools, version, executable))
    .find((aapt2) => fs.existsSync(aapt2));
};

/** `versionName` from `aapt2 dump badging`. */
export const parseBadgingVersionName = (badging: string): string | null =>
  badging.match(/\bversionName='([^']*)'/)?.[1] || null;

/**
 * A `<meta-data>` value from `aapt2 dump xmltree` of the manifest: the
 * literal, or a resource reference such as `@string/channel`, which an `.apk`
 * prints as `@0x<id>` and an `.aab` as `@string/channel`.
 */
export const parseManifestMetaData = (
  xmltree: string,
  name: string,
): string | null => {
  const lines = xmltree.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*E: meta-data\b/.test(lines[i]!)) {
      continue;
    }
    let metaDataName: string | undefined;
    let value: string | undefined;
    for (let j = i + 1; j < lines.length && /^\s*A: /.test(lines[j]!); j++) {
      metaDataName ??= lines[j]!.match(/:name\(0x[0-9a-f]+\)="([^"]*)"/)?.[1];
      const valueMatch = lines[j]!.match(
        /:value\(0x[0-9a-f]+\)=(?:"([^"]*)"|(@[\w./:]+))/,
      );
      value ??= valueMatch?.[1] ?? valueMatch?.[2];
    }
    if (metaDataName === name) {
      return value || null;
    }
  }
  return null;
};

/**
 * The string a resource reference resolves to, from `aapt2 dump resources`:
 * its default configuration's value, or else its first.
 */
export const parseResourceString = (
  resources: string,
  reference: string,
): string | null => {
  const lines = resources.split("\n");
  // `resource <id> <type>/<name>`, which either form of reference names.
  const start = lines.findIndex((line) => {
    const [, id, name] = line.match(/^\s*resource (0x[0-9a-f]+) (\S+)/) ?? [];
    return (
      id !== undefined && (reference === `@${id}` || reference === `@${name}`)
    );
  });
  if (start === -1) {
    return null;
  }
  const values: { config: string; value: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*resource 0x/.test(lines[i]!)) {
      break;
    }
    const match = lines[i]!.match(/^\s*\(([^)]*)\) "(.*)"$/);
    if (match) {
      values.push({ config: match[1]!, value: match[2]! });
    }
  }
  return (
    (values.find(({ config }) => config === "") ?? values[0])?.value ?? null
  );
};

/**
 * An `.aab` module is a proto-format APK under `base/`, which aapt2 reads
 * once its manifest and resource table sit at the root of a zip.
 */
const writeBaseModuleApk = async (aabPath: string, directory: string) => {
  const bundle = await JSZip.loadAsync(await fs.promises.readFile(aabPath));
  const module = new JSZip();
  for (const [entry, name] of [
    ["base/manifest/AndroidManifest.xml", "AndroidManifest.xml"],
    ["base/resources.pb", "resources.pb"],
  ] as const) {
    const file = bundle.file(entry);
    if (file) {
      module.file(name, await file.async("uint8array"));
    }
  }
  const apkPath = path.join(directory, "base.apk");
  await fs.promises.writeFile(
    apkPath,
    await module.generateAsync({ type: "uint8array" }),
  );
  return apkPath;
};

/**
 * What the built `.apk` or `.aab` reports at runtime: the `versionName` and
 * the `com.hotupdater.CHANNEL` meta-data Gradle merged into its manifest,
 * from flavors, build types and `versionNameSuffix`. Without aapt2 it
 * returns undefined, and the build reports the project's values.
 */
export const readBuiltApp = async ({
  artifactPath,
  androidProjectPath,
}: {
  artifactPath: string;
  androidProjectPath: string;
}): Promise<
  { appVersion: string | null; channel: string | null } | undefined
> => {
  const aapt2 = findAapt2(androidProjectPath);
  if (!aapt2) {
    p.log.warn(
      "aapt2 was not found in the Android SDK's build-tools, so the build reports the app version and channel of the project files.",
    );
    return undefined;
  }

  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "android-helper-"),
  );
  try {
    const apkPath = artifactPath.endsWith(".aab")
      ? await writeBaseModuleApk(artifactPath, directory)
      : artifactPath;
    const [badging, xmltree] = await Promise.all([
      execa(aapt2, ["dump", "badging", apkPath]),
      execa(aapt2, [
        "dump",
        "xmltree",
        "--file",
        "AndroidManifest.xml",
        apkPath,
      ]),
    ]);
    let channel = parseManifestMetaData(xmltree.stdout, CHANNEL_META_DATA_KEY);
    if (channel?.startsWith("@")) {
      const resources = await execa(aapt2, ["dump", "resources", apkPath]);
      channel = parseResourceString(resources.stdout, channel);
    }
    return {
      appVersion: parseBadgingVersionName(badging.stdout),
      channel,
    };
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};
