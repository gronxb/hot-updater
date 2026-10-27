import { isUUIDv7 } from "../uuid";
import {
  parseBinaryManifest,
  parseProtoManifest,
  readAndroidManifest,
  type ManifestValue,
} from "./androidManifest";
import { type ByteSource, NativeArtifactError } from "./byteSource";
import { parsePlist } from "./plist";
import { readDexStrings, readMachOStrings } from "./strings";
import {
  readZipDirectory,
  readZipEntry,
  readZipEntryRange,
  type ZipEntry,
} from "./zip";

/**
 * The kinds of artifact a build made elsewhere can be imported from: the
 * store artifacts, and a simulator `.app` as one zip archive (`.app.zip`,
 * the `.app` directory at its root, as Finder and `ditto` archive it).
 */
export type NativeArtifactKind = "ipa" | "aab" | "apk" | "app";

/** A value the artifact holds as something import can't read exactly. */
export interface UnreadableValue {
  readonly unreadable: string;
}

/**
 * What a store artifact compiled in, read from the artifact alone: what its
 * app reports at runtime, and the built-in bundle it ships.
 */
export interface NativeArtifactInfo {
  readonly platform: "ios" | "android";
  readonly kind: NativeArtifactKind;
  /** The bundle identifier or application ID. */
  readonly appId: string | null;
  /** `CFBundleShortVersionString` or `versionName`. */
  readonly appVersion: string | UnreadableValue | null;
  /** `CFBundleVersion` or `versionCode`. */
  readonly buildNumber: string | null;
  /**
   * `HOT_UPDATER_CHANNEL` or the `com.hotupdater.CHANNEL` meta-data: null
   * without one, which the native SDK reports as `production`.
   */
  readonly channel: string | UnreadableValue | null;
  /**
   * The UUIDv7 string literals in the app's code. MIN_BUNDLE_ID is one: the
   * native SDK's build step compiles it in.
   */
  readonly minBundleIdCandidates: readonly string[];
  /**
   * The SHA-256 hex string literals in the app's code. A build of an app
   * with fingerprint.json compiles its fingerprint in as one.
   */
  readonly fingerprintCandidates: readonly string[];
  /** The JavaScript bundle the build packed, the built-in bundle. */
  readonly builtInBundle: {
    readonly path: string;
    readonly byteSize: number;
  } | null;
}

/** Where each kind of artifact packs its built-in bundle. */
export const builtInBundlePathOf = (
  kind: NativeArtifactKind,
  appDirectory = kind === "app" ? "<App>.app/" : "Payload/<App>.app/",
): string =>
  kind === "aab"
    ? "base/assets/index.android.bundle"
    : kind === "apk"
      ? "assets/index.android.bundle"
      : `${appDirectory}main.jsbundle`;

/** The kind of artifact a file name names, or null. */
export const nativeArtifactKindOf = (
  fileName: string,
): NativeArtifactKind | null => {
  if (/\.app\.zip$/iu.test(fileName)) return "app";
  const extension = /\.([^./\\]+)$/u.exec(fileName)?.[1]?.toLowerCase();
  return extension === "ipa" || extension === "aab" || extension === "apk"
    ? extension
    : null;
};

const UUID_LENGTH = 36;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const LENGTHS: ReadonlySet<number> = new Set([UUID_LENGTH, 64]);

const unique = (values: Iterable<string>) => [...new Set(values)].sort();

const candidatesOf = (strings: Iterable<string>) => {
  const all = [...strings];
  return {
    minBundleIds: unique(all.filter(isUUIDv7)),
    fingerprints: unique(all.filter((value) => SHA256_HEX.test(value))),
  };
};

const literalOf = (
  value: ManifestValue | null | undefined,
  what: string,
): string | UnreadableValue | null => {
  if (value === null || value === undefined) return null;
  if (value.type === "string") return value.value;
  if (value.type === "int") return String(value.value);
  return {
    unreadable:
      value.type === "reference"
        ? `${what} is a resource reference (${value.name ?? `@0x${value.id.toString(16)}`}), not a literal`
        : `${what} is not a string`,
  };
};

const readAndroid = async (
  source: ByteSource,
  kind: "aab" | "apk",
  entries: readonly ZipEntry[],
): Promise<NativeArtifactInfo> => {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const manifestEntry = byName.get(
    kind === "aab"
      ? "base/manifest/AndroidManifest.xml"
      : "AndroidManifest.xml",
  );
  if (manifestEntry === undefined) {
    throw new NativeArtifactError(
      "UNREADABLE",
      `The ${kind === "aab" ? ".aab has no base/manifest/AndroidManifest.xml" : ".apk has no AndroidManifest.xml"}.`,
    );
  }
  const manifestBytes = await readZipEntry(source, manifestEntry);
  const manifest = readAndroidManifest(
    kind === "aab"
      ? parseProtoManifest(manifestBytes)
      : parseBinaryManifest(manifestBytes),
  );
  const strings: string[] = [];
  for (const entry of entries) {
    const isDex =
      kind === "aab"
        ? /^base\/dex\/classes\d*\.dex$/u.test(entry.name)
        : /^classes\d*\.dex$/u.test(entry.name);
    if (!isDex) continue;
    strings.push(...readDexStrings(await readZipEntry(source, entry), LENGTHS));
  }
  const { minBundleIds, fingerprints } = candidatesOf(strings);
  const bundle = byName.get(builtInBundlePathOf(kind));
  return {
    platform: "android",
    kind,
    appId: manifest.packageName,
    appVersion: literalOf(manifest.versionName, "versionName"),
    buildNumber:
      manifest.versionCode === null ? null : String(manifest.versionCode),
    channel: literalOf(
      manifest.metaData.get("com.hotupdater.CHANNEL"),
      "The com.hotupdater.CHANNEL meta-data",
    ),
    minBundleIdCandidates: minBundleIds,
    fingerprintCandidates: fingerprints,
    builtInBundle:
      bundle === undefined
        ? null
        : { path: bundle.name, byteSize: bundle.uncompressedSize },
  };
};

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const readIos = async (
  source: ByteSource,
  kind: "ipa" | "app",
  entries: readonly ZipEntry[],
): Promise<NativeArtifactInfo> => {
  const infoPlist =
    kind === "ipa"
      ? /^Payload\/[^/]+\.app\/Info\.plist$/u
      : /^[^/]+\.app\/Info\.plist$/u;
  const plistEntry = entries.find(({ name }) => infoPlist.test(name));
  if (plistEntry === undefined) {
    throw new NativeArtifactError(
      "UNREADABLE",
      kind === "ipa"
        ? "The .ipa has no Payload/<App>.app/Info.plist."
        : "The .app.zip has no <App>.app/Info.plist at its root.",
    );
  }
  const appDirectory = plistEntry.name.slice(0, -"Info.plist".length);
  const plist = parsePlist(await readZipEntry(source, plistEntry));
  if (plist === null || typeof plist !== "object" || Array.isArray(plist)) {
    throw new NativeArtifactError(
      "UNREADABLE",
      "The app's Info.plist is not a dictionary.",
    );
  }
  const info = plist as Record<string, unknown>;
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const machO = (entry: ZipEntry) =>
    readMachOStrings(
      (start, end) => readZipEntryRange(source, entry, start, end),
      LENGTHS,
    );
  // The SDK compiles MIN_BUNDLE_ID and the fingerprint into its own code:
  // HotUpdater's framework when the app links frameworks dynamically, which
  // then decides alone, whatever other code holds; else the app's
  // executable; else, under another framework's name, every framework,
  // whose candidates together must be one.
  const frameworks = entries.filter(({ name }) => {
    const match = new RegExp(
      `^${appDirectory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}Frameworks/([^/]+)\\.framework/([^/]+)$`,
      "u",
    ).exec(name);
    return match !== null && match[1] === match[2];
  });
  const sdk = frameworks.find(({ name }) => name.endsWith("/HotUpdater"));
  const executable = stringValue(info["CFBundleExecutable"]);
  const executableEntry =
    executable === null
      ? undefined
      : byName.get(`${appDirectory}${executable}`);
  let strings = sdk === undefined ? [] : await machO(sdk);
  if (!strings.some(isUUIDv7) && executableEntry !== undefined) {
    strings = await machO(executableEntry);
  }
  if (!strings.some(isUUIDv7)) {
    for (const framework of frameworks) {
      if (framework !== sdk) strings.push(...(await machO(framework)));
    }
  }
  const { minBundleIds, fingerprints } = candidatesOf(strings);
  const bundle = byName.get(builtInBundlePathOf(kind, appDirectory));
  const channel = info["HOT_UPDATER_CHANNEL"];
  return {
    platform: "ios",
    kind,
    appId: stringValue(info["CFBundleIdentifier"]),
    appVersion: stringValue(info["CFBundleShortVersionString"]),
    buildNumber: stringValue(info["CFBundleVersion"]),
    channel:
      channel === undefined || channel === ""
        ? null
        : typeof channel === "string"
          ? channel
          : { unreadable: "HOT_UPDATER_CHANNEL is not a string" },
    minBundleIdCandidates: minBundleIds,
    fingerprintCandidates: fingerprints,
    builtInBundle:
      bundle === undefined
        ? null
        : { path: bundle.name, byteSize: bundle.uncompressedSize },
  };
};

/**
 * Reads a store artifact (`.ipa`, `.aab` or `.apk`) by its file name's
 * extension: what its app reports at runtime, and its built-in bundle. It
 * reads the archive's directory, the manifest or Info.plist, and the app's
 * code, but not the built-in bundle, so a large artifact is never held
 * whole. Whether the result can be imported is `checkNativeArtifact`'s.
 */
export const readNativeArtifact = async (
  source: ByteSource,
  fileName: string,
): Promise<NativeArtifactInfo> => {
  const kind = nativeArtifactKindOf(fileName);
  if (kind === null) {
    throw new NativeArtifactError(
      "UNSUPPORTED_FILE",
      `${fileName} is not an .ipa, .aab, .apk or a simulator .app. Import the artifact of a release build.`,
    );
  }
  const entries = await readZipDirectory(source);
  return kind === "ipa" || kind === "app"
    ? readIos(source, kind, entries)
    : readAndroid(source, kind, entries);
};
