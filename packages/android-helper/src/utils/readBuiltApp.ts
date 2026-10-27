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

const RAW_MARKER = '" (Raw: "';

/**
 * An attribute aapt2 prints as `="<value>" (Raw: "<value>")`, given the text
 * after `="`. aapt2 does not escape the value, so it is the prefix the rest
 * of the line repeats; a value with a line break, which aapt2 indents, reads
 * as undefined.
 */
const readQuotedValue = (rest: string): string | undefined => {
  for (
    let end = rest.indexOf(RAW_MARKER);
    end !== -1;
    end = rest.indexOf(RAW_MARKER, end + 1)
  ) {
    const value = rest.slice(0, end);
    if (rest === `${value}${RAW_MARKER}${value}")`) {
      return value;
    }
  }
  return undefined;
};

/**
 * The value of the attribute `marker` (such as `:value(0x01010024)=`) on
 * `line`: null without one, and undefined when it cannot be read exactly.
 */
const readAttribute = (
  line: string,
  marker: string,
): string | null | undefined => {
  const start = line.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const rest = line.slice(start + marker.length);
  if (rest.startsWith('"')) {
    return readQuotedValue(rest.slice(1));
  }
  // A resource reference, which an `.apk` prints as `@0x<id>` and an `.aab`
  // as `@string/channel`.
  return rest.match(/^@[\w./:]+/)?.[0];
};

/**
 * A `<meta-data>` value from `aapt2 dump xmltree` of the manifest: the
 * literal, or a resource reference such as `@string/channel`. null when the
 * manifest has none, and undefined when aapt2 printed one it cannot read
 * exactly.
 */
export const parseManifestMetaData = (
  xmltree: string,
  name: string,
): string | null | undefined => {
  const lines = xmltree.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*E: meta-data\b/.test(lines[i]!)) {
      continue;
    }
    let metaDataName: string | null | undefined = null;
    let value: string | null | undefined = null;
    for (let j = i + 1; j < lines.length && /^\s*A: /.test(lines[j]!); j++) {
      metaDataName ||= readAttribute(lines[j]!, ":name(0x01010003)=");
      if (value === null) {
        value = readAttribute(lines[j]!, ":value(0x01010024)=");
      }
    }
    if (metaDataName === name) {
      return value ?? undefined;
    }
  }
  return null;
};

/**
 * The `android:versionName` of the `<manifest>` element in `aapt2 dump
 * xmltree`, which Gradle merges from the variant, with its suffixes: null
 * without one, and undefined when it cannot be read exactly.
 */
export const parseManifestVersionName = (
  xmltree: string,
): string | null | undefined => {
  for (const line of xmltree.split("\n")) {
    const value = readAttribute(line, ":versionName(0x0101021c)=");
    if (value !== null) {
      return value;
    }
  }
  return null;
};

/**
 * The `android:versionCode` of the `<manifest>` element in `aapt2 dump
 * xmltree`, an integer aapt2 prints bare or quoted: null without one.
 */
export const parseManifestVersionCode = (xmltree: string): number | null => {
  const match = /:versionCode\(0x0101021b\)="?(\d+)/.exec(xmltree);
  return match ? Number(match[1]) : null;
};

/**
 * The string a resource reference resolves to, from `aapt2 dump resources`:
 * its default configuration's value, or else its first. undefined when the
 * table has none aapt2 printed on one line.
 */
export const parseResourceString = (
  resources: string,
  reference: string,
): string | undefined => {
  const lines = resources.split("\n");
  // `resource <id> <type>/<name>`, which either form of reference names.
  const start = lines.findIndex((line) => {
    const [, id, name] = line.match(/^\s*resource (0x[0-9a-f]+) (\S+)/) ?? [];
    return (
      id !== undefined && (reference === `@${id}` || reference === `@${name}`)
    );
  });
  if (start === -1) {
    return undefined;
  }
  const values: { config: string; value: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*resource 0x/.test(lines[i]!)) {
      break;
    }
    // aapt2 prints `(<config>) "<value>"` unescaped, so the value runs to
    // the line's last quote. A value with a line break continues, indented,
    // on the next line, so this reads it as none.
    const match = lines[i]!.match(/^\s*\(([^)]*)\) "(.*)"$/);
    if (match) {
      values.push({ config: match[1]!, value: match[2]! });
    }
  }
  return (values.find(({ config }) => config === "") ?? values[0])?.value;
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
  | {
      appVersion: string | null;
      /** undefined when the artifact's channel cannot be read exactly. */
      channel?: string | null;
      /** The manifest's `versionCode`. */
      buildNumber: string | null;
    }
  | undefined
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
    const { stdout: xmltree } = await execa(aapt2, [
      "dump",
      "xmltree",
      "--file",
      "AndroidManifest.xml",
      apkPath,
    ]);
    // Either value may name a string resource, which the resource table
    // resolves.
    let resources: Promise<string> | undefined;
    const resolve = async (value: string | null | undefined) => {
      if (!value?.startsWith("@")) {
        return value;
      }
      resources ??= execa(aapt2, ["dump", "resources", apkPath]).then(
        ({ stdout }) => stdout,
      );
      return parseResourceString(await resources, value);
    };
    const appVersion = await resolve(parseManifestVersionName(xmltree));
    const channel = await resolve(
      parseManifestMetaData(xmltree, CHANNEL_META_DATA_KEY),
    );
    if (appVersion === undefined || channel === undefined) {
      p.log.warn(
        "aapt2 printed the artifact's versionName or com.hotupdater.CHANNEL in a form that cannot be read exactly, so the build reports the project files' value for it.",
      );
    }
    const versionCode = parseManifestVersionCode(xmltree);
    return {
      appVersion: appVersion ?? null,
      channel,
      buildNumber: versionCode === null ? null : String(versionCode),
    };
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};

/**
 * The application ID of the built `.apk` or `.aab`, the package name Google
 * Play files it under, with the suffixes flavors and build types add.
 * undefined without aapt2.
 */
export const readBuiltPackageName = async ({
  artifactPath,
  androidProjectPath,
}: {
  artifactPath: string;
  androidProjectPath: string;
}): Promise<string | undefined> => {
  const aapt2 = findAapt2(androidProjectPath);
  if (!aapt2) {
    return undefined;
  }
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "android-helper-"),
  );
  try {
    const apkPath = artifactPath.endsWith(".aab")
      ? await writeBaseModuleApk(artifactPath, directory)
      : artifactPath;
    const { stdout } = await execa(aapt2, ["dump", "packagename", apkPath]);
    return stdout.trim() || undefined;
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};

/**
 * The version code of the built `.apk` or `.aab`, which Google Play files
 * its releases by. undefined without aapt2, or when the manifest has none.
 */
export const readBuiltVersionCode = async ({
  artifactPath,
  androidProjectPath,
}: {
  artifactPath: string;
  androidProjectPath: string;
}): Promise<number | undefined> => {
  const aapt2 = findAapt2(androidProjectPath);
  if (!aapt2) {
    return undefined;
  }
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "android-helper-"),
  );
  try {
    const apkPath = artifactPath.endsWith(".aab")
      ? await writeBaseModuleApk(artifactPath, directory)
      : artifactPath;
    const { stdout } = await execa(aapt2, [
      "dump",
      "xmltree",
      "--file",
      "AndroidManifest.xml",
      apkPath,
    ]);
    return parseManifestVersionCode(stdout) ?? undefined;
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};
