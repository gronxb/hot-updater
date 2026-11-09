import fs from "fs";
import path from "path";

import { BuildFailedError, p } from "@hot-updater/cli-tools";
import {
  SANDBOX_INFO_PLIST_KEY,
  SANDBOX_URL_TYPE_NAME,
  sandboxChannelOf,
  sandboxUrlSchemeOf,
} from "@hot-updater/protocol/native-artifact";
import { execa } from "execa";

import {
  type SandboxArchivePlan,
  sandboxVersionDecision,
} from "../sandboxTestFlight";

const CAMERA_USAGE = "Scans the QR code of a preview to open it in this build.";
const LOCAL_NETWORK_USAGE =
  "Connects to the dev server you choose on this network.";
const ATS_KEY = "NSAppTransportSecurity";
const ATS_LOCAL_NETWORKING_KEY = "NSAllowsLocalNetworking";

/** A refusal the command prints as it is: the build ran as it should. */
const refusal = (message: string) =>
  new BuildFailedError(message, {
    logPath: null,
    summary: [],
    hint: message,
  });

const plutil = (args: string[]) => execa("plutil", args);

const readValue = async (plist: string, key: string) => {
  const { stdout, exitCode } = await execa(
    "plutil",
    ["-extract", key, "raw", "-o", "-", plist],
    { reject: false },
  );
  return exitCode === 0 && stdout.trim() ? stdout.trim() : null;
};

const setString = (plist: string, key: string, value: string) =>
  plutil(["-replace", key, "-string", value, plist]);

/** The app's own URL types, or null when it has none. */
const readUrlTypes = async (plist: string): Promise<unknown[] | null> => {
  const { stdout, exitCode } = await execa(
    "plutil",
    ["-extract", "CFBundleURLTypes", "json", "-o", "-", plist],
    { reject: false },
  );
  return exitCode === 0 ? (JSON.parse(stdout) as unknown[]) : null;
};

const isSandboxUrlType = (type: unknown) =>
  (type as { CFBundleURLName?: unknown } | null)?.CFBundleURLName ===
  SANDBOX_URL_TYPE_NAME;

/**
 * Appends a URL type with the sandbox's scheme to the app's own, or replaces
 * the one an earlier patch of the same app added.
 */
const addUrlScheme = async (
  plist: string,
  urlScheme: string,
  existing: unknown[] | null,
) => {
  const urlType = JSON.stringify({
    CFBundleURLName: SANDBOX_URL_TYPE_NAME,
    CFBundleURLSchemes: [urlScheme],
  });
  const patched = existing?.findIndex(isSandboxUrlType) ?? -1;
  if (patched !== -1) {
    // `-replace` of an array's item inserts before it.
    await plutil(["-remove", `CFBundleURLTypes.${patched}`, plist]);
    await plutil([
      "-insert",
      `CFBundleURLTypes.${patched}`,
      "-json",
      urlType,
      plist,
    ]);
    return;
  }
  if (existing === null) {
    await plutil([
      "-insert",
      "CFBundleURLTypes",
      "-json",
      `[${urlType}]`,
      plist,
    ]);
    return;
  }
  await plutil([
    "-insert",
    `CFBundleURLTypes.${existing.length}`,
    "-json",
    urlType,
    plist,
  ]);
};

/**
 * Whether the app's own URL types list `urlScheme`, as iOS compares schemes:
 * ignoring case. The sandbox's own, from an earlier patch, isn't the app's.
 */
const registersUrlScheme = (urlTypes: unknown, urlScheme: string): boolean =>
  Array.isArray(urlTypes) &&
  urlTypes.some((type) => {
    if (isSandboxUrlType(type)) return false;
    const schemes = (type as { CFBundleURLSchemes?: unknown } | null)
      ?.CFBundleURLSchemes;
    return (
      Array.isArray(schemes) &&
      schemes.some(
        (scheme) =>
          typeof scheme === "string" &&
          scheme.toLowerCase() === urlScheme.toLowerCase(),
      )
    );
  });

const hasKey = async (plist: string, key: string) => {
  const { exitCode } = await execa(
    "plutil",
    ["-extract", key, "xml1", "-o", "-", plist],
    { reject: false },
  );
  return exitCode === 0;
};

/**
 * What the sandbox's screen asks the system for: the camera for its QR scanner,
 * and the local network for a dev server. A value the app already set stays, and
 * nested App Transport Security entries stay beside the one this adds.
 */
const addSandboxPermissions = async (plist: string) => {
  for (const [key, value] of [
    ["NSCameraUsageDescription", CAMERA_USAGE],
    ["NSLocalNetworkUsageDescription", LOCAL_NETWORK_USAGE],
  ] as const) {
    if (!(await hasKey(plist, key))) {
      await plutil(["-insert", key, "-string", value, plist]);
    }
  }
  if (!(await hasKey(plist, ATS_KEY))) {
    await plutil([
      "-insert",
      ATS_KEY,
      "-json",
      `{"${ATS_LOCAL_NETWORKING_KEY}":true}`,
      plist,
    ]);
  } else if (!(await hasKey(plist, `${ATS_KEY}.${ATS_LOCAL_NETWORKING_KEY}`))) {
    await plutil([
      "-insert",
      `${ATS_KEY}.${ATS_LOCAL_NETWORKING_KEY}`,
      "-bool",
      "true",
      plist,
    ]);
  }
};

/** What a sandbox build's Info.plist is patched from. */
export interface SandboxPlistScheme {
  hotUpdaterSchemeName: string;
  bundleIdentifier: string;
  /** The URL scheme the build registers; null derives it from `bundleIdentifier`. */
  sandboxUrlScheme?: string | null;
}

/**
 * The app's dedicated URL scheme, default channel, and the sandbox's key. The
 * URL scheme, unless the scheme sets one, and App Store Connect's app come
 * from the scheme's `bundleIdentifier`, while Xcode's build settings decide
 * the app's ID, so an app of another ID stops here, before anything is signed
 * or uploaded.
 */
const patchAppInfoPlist = async (plist: string, scheme: SandboxPlistScheme) => {
  const built = await readValue(plist, "CFBundleIdentifier");
  if (built !== scheme.bundleIdentifier) {
    throw refusal(
      `The sandbox scheme ${scheme.hotUpdaterSchemeName} sets bundleIdentifier ${scheme.bundleIdentifier}, but Xcode built ${built ?? "no bundle ID"}.\nSet bundleIdentifier to the ID its configuration builds.`,
    );
  }
  // A scheme the app registers itself would ask which app opens its links.
  const urlScheme =
    scheme.sandboxUrlScheme ?? sandboxUrlSchemeOf(scheme.bundleIdentifier);
  const urlTypes = await readUrlTypes(plist);
  if (registersUrlScheme(urlTypes, urlScheme)) {
    throw refusal(
      `The sandbox scheme ${scheme.hotUpdaterSchemeName} registers URL scheme ${urlScheme}, which the app registers itself.\nSet sandbox.urlScheme to a scheme the app doesn't register.`,
    );
  }
  await setString(
    plist,
    "HOT_UPDATER_CHANNEL",
    sandboxChannelOf(scheme.hotUpdaterSchemeName),
  );
  await plutil(["-replace", SANDBOX_INFO_PLIST_KEY, "-bool", "true", plist]);
  await addUrlScheme(plist, urlScheme, urlTypes);
  await addSandboxPermissions(plist);
};

/** The Info.plist of each app extension inside an `.app`. */
const extensionInfoPlists = (appPath: string): string[] =>
  ["PlugIns", "Extensions"].flatMap((directory) => {
    const extensions = path.join(appPath, directory);
    if (!fs.existsSync(extensions)) return [];
    return fs
      .readdirSync(extensions)
      .filter((name) => name.endsWith(".appex"))
      .map((name) => path.join(extensions, name, "Info.plist"));
  });

/**
 * Makes the archived app a sandbox app before `-exportArchive`, which signs
 * what it finds, so no project file changes: its URL scheme, default channel
 * and key, and from App Store Connect, the version a closed train needs and
 * the next build number, in its extensions too, which must match it.
 */
export const patchSandboxArchive = async ({
  archivePath,
  appPath,
  schemeConfig,
  plan,
}: {
  archivePath: string;
  appPath: string;
  schemeConfig: SandboxPlistScheme;
  plan?: SandboxArchivePlan;
}): Promise<void> => {
  const appPlist = path.join(appPath, "Info.plist");
  await patchAppInfoPlist(appPlist, schemeConfig);

  const train = plan?.train;
  if (!train) return;
  const version = await readValue(appPlist, "CFBundleShortVersionString");
  const buildNumber = await readValue(appPlist, "CFBundleVersion");
  const raised =
    version === null
      ? undefined
      : sandboxVersionDecision({
          version,
          train,
          updateStrategy: plan.updateStrategy,
        });
  if (raised?.kind === "refuse") throw refusal(raised.message);
  const newVersion = raised?.kind === "raise" ? raised.version : null;
  const newBuildNumber = nextBuildNumber(buildNumber, train.highestBuildNumber);

  const bundles = [appPlist, ...extensionInfoPlists(appPath)];
  const archivePlist = path.join(archivePath, "Info.plist");
  const properties = "ApplicationProperties";
  if (newVersion !== null) {
    for (const plist of bundles) {
      await setString(plist, "CFBundleShortVersionString", newVersion);
    }
    await setString(
      archivePlist,
      `${properties}.CFBundleShortVersionString`,
      newVersion,
    );
    p.log.info(
      `Sandbox version ${newVersion}: App Store Connect closed ${version}.`,
    );
  }
  if (newBuildNumber !== null) {
    for (const plist of bundles) {
      await setString(plist, "CFBundleVersion", newBuildNumber);
    }
    await setString(
      archivePlist,
      `${properties}.CFBundleVersion`,
      newBuildNumber,
    );
  }
};

/**
 * The build number to set over `current`: the one after App Store Connect's
 * highest, or null to keep `current`, already higher, or one that isn't an
 * integer such as `1.2.3`.
 */
export const nextBuildNumber = (
  current: string | null,
  highest: number | null,
): string | null => {
  if (highest === null) return null;
  if (current !== null && !/^\d+$/u.test(current)) return null;
  if (current !== null && Number(current) > highest) return null;
  return String(highest + 1);
};

/**
 * Makes a built simulator `.app` a sandbox app, and signs it again ad hoc, as
 * Xcode does for the simulator, since its signature covers the Info.plist.
 */
export const patchSandboxSimulatorApp = async (
  appPath: string,
  schemeConfig: SandboxPlistScheme,
): Promise<void> => {
  await patchAppInfoPlist(path.join(appPath, "Info.plist"), schemeConfig);
  await execa("codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--preserve-metadata=entitlements",
    appPath,
  ]);
};
