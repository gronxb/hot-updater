import fs from "fs";
import path from "path";

import { BuildFailedError, p } from "@hot-updater/cli-tools";
import {
  SANDBOX_INFO_PLIST_KEY,
  SANDBOX_URL_SCHEME_INFO_PLIST_KEY,
  SANDBOX_URL_TYPE_NAME,
  isRecordedUrlSchemeSyntax,
  isSandboxUrlScheme,
  recordedSandboxUrlScheme,
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
 * Appends a URL type with the sandbox's scheme to the app's own, or, in an
 * app an earlier patch made a sandbox app, replaces the one that patch added.
 */
const addUrlScheme = async (
  plist: string,
  urlScheme: string,
  existing: unknown[] | null,
  patchedBefore: boolean,
) => {
  const urlType = JSON.stringify({
    CFBundleURLName: SANDBOX_URL_TYPE_NAME,
    CFBundleURLSchemes: [urlScheme],
  });
  const patched = patchedBefore
    ? (existing?.findIndex(isSandboxUrlType) ?? -1)
    : -1;
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

/** The schemes a URL type lists. */
const schemesOf = (type: unknown): unknown[] => {
  const schemes = (type as { CFBundleURLSchemes?: unknown } | null)
    ?.CFBundleURLSchemes;
  return Array.isArray(schemes) ? schemes : [];
};

/** Whether URL types list `urlScheme`, as iOS compares schemes: ignoring case. */
const registersUrlScheme = (
  urlTypes: readonly unknown[],
  urlScheme: string,
): boolean =>
  urlTypes.some((type) => {
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
 * The app's dedicated URL scheme and the sandbox's key: its channel stays the
 * project's, as any build's does. The
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
  // Only an app an earlier patch made a sandbox app has a URL type of the
  // sandbox's name that isn't the app's own.
  const urlScheme =
    scheme.sandboxUrlScheme ?? sandboxUrlSchemeOf(scheme.bundleIdentifier);
  const urlTypes = await readUrlTypes(plist);
  const patchedBefore =
    (await readValue(plist, SANDBOX_INFO_PLIST_KEY)) === "true";
  const appUrlTypes = (urlTypes ?? []).filter(
    (type) => !(patchedBefore && isSandboxUrlType(type)),
  );
  if (appUrlTypes.some(isSandboxUrlType)) {
    throw refusal(
      `The app has a URL type named ${SANDBOX_URL_TYPE_NAME}, the name a sandbox build registers its URL scheme under.\nRename the app's URL type.`,
    );
  }
  if (patchedBefore) {
    await refuseForeignSandboxUrlTypes(plist, urlTypes ?? [], scheme);
  }
  if (registersUrlScheme(appUrlTypes, urlScheme)) {
    throw refusal(
      `The sandbox scheme ${scheme.hotUpdaterSchemeName} registers URL scheme ${urlScheme}, which the app registers itself.\nSet sandbox.urlScheme to a scheme the app doesn't register.`,
    );
  }
  await plutil(["-replace", SANDBOX_INFO_PLIST_KEY, "-bool", "true", plist]);
  await addUrlScheme(plist, urlScheme, urlTypes, patchedBefore);
  await setString(plist, SANDBOX_URL_SCHEME_INFO_PLIST_KEY, urlScheme);
  await addSandboxPermissions(plist);
};

/**
 * A key's value as written, or undefined when the plist has no such key:
 * strings, numbers and booleans as they are, and any other type as itself
 * named, which no rule takes. `-extract … json` refuses a lone scalar.
 */
const readTyped = async (plist: string, key: string): Promise<unknown> => {
  const type = await execa("plutil", ["-type", key, plist], { reject: false });
  if (type.exitCode !== 0) return undefined;
  const { stdout } = await execa(
    "plutil",
    ["-extract", key, "raw", "-o", "-", plist],
    { reject: false, stripFinalNewline: false },
  );
  const raw = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  switch (type.stdout.trim()) {
    case "string":
      return raw;
    case "integer":
    case "float":
      return Number(raw);
    case "bool":
      return raw === "true";
    default:
      return `<${type.stdout.trim()}>`;
  }
};

/**
 * Refuses, in an app an earlier patch made a sandbox app, what replacing its
 * URL type of the sandbox's name could break: by `recordedSandboxUrlScheme`'s
 * rule, the one URL type of the name must hold the one scheme the patch
 * recorded alone. A prerelease's patch recorded none, and registered one with
 * the derived scheme's prefix.
 */
const refuseForeignSandboxUrlTypes = async (
  plist: string,
  urlTypes: readonly unknown[],
  scheme: SandboxPlistScheme,
) => {
  const named = urlTypes.filter(isSandboxUrlType);
  const value = await readTyped(plist, SANDBOX_URL_SCHEME_INFO_PLIST_KEY);
  const recorded = recordedSandboxUrlScheme(value, named);
  if (typeof recorded === "string") return;
  const schemes = named.flatMap(schemesOf);
  if (recorded === undefined) {
    const only = named.length === 1 && schemes.length === 1 ? schemes[0] : null;
    if (typeof only === "string" && isSandboxUrlScheme(only)) return;
  } else if (!isRecordedUrlSchemeSyntax(value)) {
    throw refusal(
      `The app's Info.plist records sandbox URL scheme ${JSON.stringify(value)} in ${SANDBOX_URL_SCHEME_INFO_PLIST_KEY}, which isn't a URL scheme.\nBuild the app again: a new build records none.`,
    );
  }
  const keep = isRecordedUrlSchemeSyntax(value)
    ? value
    : sandboxUrlSchemeOf(scheme.bundleIdentifier);
  const holds = schemes.map(String).join(", ") || "no scheme";
  const found =
    named.length === 1
      ? `The app's ${SANDBOX_URL_TYPE_NAME} URL type holds ${holds}.`
      : `The app has ${named.length} ${SANDBOX_URL_TYPE_NAME} URL types${named.length === 0 ? "" : `, holding ${holds}`}.`;
  throw refusal(
    `${found}\nKeep exactly one ${SANDBOX_URL_TYPE_NAME} URL type, holding only ${keep}, and move the rest to a URL type of the app's own.`,
  );
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
 * what it finds, so no project file changes: its URL scheme and key, and from App Store Connect, the version a closed train needs and
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
