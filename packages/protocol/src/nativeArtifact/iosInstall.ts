import { type ByteSource, NativeArtifactError } from "./byteSource";
import { parsePlist, type PlistValue } from "./plist";
import {
  filterZipEntries,
  findZipEntry,
  readZipDirectory,
  readZipEntry,
  type ZipEntry,
  type ZipReadBudget,
} from "./zip";

const KiB = 1024;
const MiB = 1024 * KiB;
/** The most an app's Info.plist or a provisioning profile holds here. */
const METADATA_BYTES = 1 * MiB;
/** The most reading what an install needs inflates, across every entry. */
const READ_BUDGET_BYTES = 8 * MiB;
/** How long reading what an install needs may take. */
const READ_TIMEOUT_MS = 30_000;
/** The extensions an app may carry, each with a profile to read. */
const MAX_NESTED_PROFILES = 16;

const APP_INFO_PLIST = /^Payload\/[^/]+\.app\/Info\.plist$/u;
/**
 * What installs with the app and must list the device too: not a Watch app's
 * profile, which lists watches and installs on one.
 */
const NESTED_PROFILE =
  /^Payload\/[^/]+\.app\/(?:PlugIns|Extensions|AppClips)\/[^/]+\.(?:appex|app)\/embedded\.mobileprovision$/u;

/**
 * How an `.ipa`'s profile lets it install: on the devices it lists (`ad-hoc`,
 * `development`), on any device of the team's company (`enterprise`), or only
 * through a store, as an App Store export's has no device list (`store`).
 */
export type IpaDistribution = "ad-hoc" | "development" | "enterprise" | "store";

/** What installing an `.ipa` over the air needs to know, read from the `.ipa`. */
export interface IpaInstallInfo {
  /** `CFBundleIdentifier`. */
  readonly bundleId: string;
  /** `CFBundleVersion`. */
  readonly bundleVersion: string;
  /** The name an install shows: `CFBundleDisplayName`, or `CFBundleName`. */
  readonly title: string;
  readonly distribution: IpaDistribution;
  /**
   * The normalized UDIDs that every profile of the app lists, so a device
   * here installs all of it. Empty for `enterprise` and `store`.
   */
  readonly devices: readonly string[];
  /** When the first of the app's profiles expires, or null with none. */
  readonly expiresAtMs: number | null;
}

/** A device's UDID: 40 hex digits, or 8 and 16 joined by a hyphen. */
const UDID = /^(?:[0-9a-f]{40}|[0-9a-f]{8}-[0-9a-f]{16})$/iu;

/**
 * The form two UDIDs compare in, or null for text that isn't one. Apple writes
 * them in either case, and App Store Connect takes the device's own.
 */
export const normalizeIosUdid = (value: string): string | null => {
  const trimmed = value.trim();
  return UDID.test(trimmed) ? trimmed.toLowerCase() : null;
};

/**
 * The bytes from `<?xml` through `</plist>`, or null without both: a CMS
 * message, as a provisioning profile and a Profile Service answer are, holds
 * its plist as plain text among binary bytes.
 */
const sliceEmbeddedPlist = (bytes: Uint8Array): Uint8Array | null => {
  // latin1 turns each byte into one character, so positions carry over.
  const text = new TextDecoder("latin1").decode(bytes);
  const start = text.indexOf("<?xml");
  if (start === -1) return null;
  const close = "</plist>";
  const end = text.indexOf(close, start);
  return end === -1 ? null : bytes.subarray(start, end + close.length);
};

/**
 * The UDID in a Profile Service answer's body, or null when it has no one
 * well-formed UDID. It only finds the text: nothing here verifies the signature
 * around it, so nothing automated may trust the result.
 */
export const readProfileServiceUdid = (body: Uint8Array): string | null => {
  const plist = sliceEmbeddedPlist(body);
  if (plist === null) return null;
  const matches = [
    ...new TextDecoder()
      .decode(plist)
      .matchAll(/<key>\s*UDID\s*<\/key>\s*<string>([^<]*)<\/string>/gu),
  ];
  if (matches.length !== 1) return null;
  const udid = matches[0]![1]!.trim();
  return normalizeIosUdid(udid) === null ? null : udid;
};

const unreadable = (message: string) =>
  new NativeArtifactError("UNREADABLE", message);

const isDict = (
  value: PlistValue | undefined,
): value is Record<string, PlistValue> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array);

/** One provisioning profile: `devices` is null for one that lists none. */
interface Profile {
  readonly allDevices: boolean;
  readonly devices: ReadonlySet<string> | null;
  readonly getTaskAllow: boolean;
  readonly expiresAtMs: number | null;
}

const readProfile = (bytes: Uint8Array, name: string): Profile => {
  const plistBytes = sliceEmbeddedPlist(bytes);
  if (plistBytes === null) {
    throw unreadable(`The archive's ${name} holds no property list.`);
  }
  const plist = parsePlist(plistBytes);
  if (!isDict(plist)) throw unreadable(`The archive's ${name} is corrupt.`);

  const listed = plist["ProvisionedDevices"];
  if (listed !== undefined && !Array.isArray(listed)) {
    throw unreadable(`The archive's ${name} is corrupt.`);
  }
  const devices = listed?.map((device) => {
    if (typeof device !== "string") {
      throw unreadable(`The archive's ${name} is corrupt.`);
    }
    return device.trim().toLowerCase();
  });

  const expiration = plist["ExpirationDate"];
  const expiresAtMs =
    typeof expiration === "string" ? Date.parse(expiration) : null;
  if (expiresAtMs !== null && Number.isNaN(expiresAtMs)) {
    throw unreadable(`The archive's ${name} is corrupt.`);
  }

  const entitlements = plist["Entitlements"];
  return {
    allDevices: plist["ProvisionsAllDevices"] === true,
    devices: devices === undefined ? null : new Set(devices),
    getTaskAllow:
      isDict(entitlements) && entitlements["get-task-allow"] === true,
    expiresAtMs,
  };
};

const distributionOf = (profile: Profile | null): IpaDistribution => {
  if (profile === null) return "store";
  if (profile.allDevices) return "enterprise";
  if (profile.devices === null) return "store";
  return profile.getTaskAllow ? "development" : "ad-hoc";
};

/**
 * What an `.ipa` installs as, reading only its directory, its app's Info.plist
 * and its provisioning profiles: a few requests of a remote file, whatever its
 * size. The `.ipa` is untrusted, and each part is bounded before it is read.
 * Throws `NativeArtifactError` for one it can't read.
 */
export const readIpaInstallInfo = async (
  source: ByteSource,
): Promise<IpaInstallInfo> => {
  const entries = await readZipDirectory(source);
  const infoPlists = filterZipEntries(entries, (name) =>
    APP_INFO_PLIST.test(name),
  );
  const infoEntry = infoPlists[0];
  if (infoEntry === undefined || infoPlists.length > 1) {
    throw unreadable("The .ipa has no one Payload/<App>.app/Info.plist.");
  }
  const budget: ZipReadBudget = {
    remaining: READ_BUDGET_BYTES,
    deadline: Date.now() + READ_TIMEOUT_MS,
  };
  const read = (entry: ZipEntry) =>
    readZipEntry(source, entry, METADATA_BYTES, budget);

  const info = parsePlist(await read(infoEntry));
  if (!isDict(info)) throw unreadable("The app's Info.plist is corrupt.");
  const bundleId = info["CFBundleIdentifier"];
  const bundleVersion = info["CFBundleVersion"];
  if (typeof bundleId !== "string" || bundleId === "") {
    throw unreadable("The app's Info.plist has no CFBundleIdentifier.");
  }
  if (typeof bundleVersion !== "string" || bundleVersion === "") {
    throw unreadable("The app's Info.plist has no CFBundleVersion.");
  }
  const displayName = info["CFBundleDisplayName"];
  const bundleName = info["CFBundleName"];
  const title =
    typeof displayName === "string" && displayName !== ""
      ? displayName
      : typeof bundleName === "string" && bundleName !== ""
        ? bundleName
        : bundleId;

  const appDirectory = infoEntry.name.slice(0, -"Info.plist".length);
  const profileEntry = findZipEntry(
    entries,
    `${appDirectory}embedded.mobileprovision`,
  );
  const nestedEntries = filterZipEntries(
    entries,
    (name) => name.startsWith(appDirectory) && NESTED_PROFILE.test(name),
  );
  if (nestedEntries.length > MAX_NESTED_PROFILES) {
    throw unreadable(
      `The app has more than ${MAX_NESTED_PROFILES} extensions with profiles.`,
    );
  }

  const profile =
    profileEntry === undefined
      ? null
      : readProfile(await read(profileEntry), profileEntry.name);
  const nested: Profile[] = [];
  for (const entry of nestedEntries) {
    nested.push(readProfile(await read(entry), entry.name));
  }

  const distribution = distributionOf(profile);
  const profiles = profile === null ? nested : [profile, ...nested];
  const listDevices =
    distribution === "ad-hoc" || distribution === "development";
  const lists = profiles.flatMap(({ allDevices, devices }) =>
    allDevices ? [] : [devices ?? new Set<string>()],
  );
  const expiries = profiles.flatMap(({ expiresAtMs }) =>
    expiresAtMs === null ? [] : [expiresAtMs],
  );
  return {
    bundleId,
    bundleVersion,
    title,
    distribution,
    devices: listDevices
      ? [...(lists[0] ?? [])]
          .filter((udid) => lists.every((list) => list.has(udid)))
          .sort()
      : [],
    expiresAtMs: expiries.length === 0 ? null : Math.min(...expiries),
  };
};
