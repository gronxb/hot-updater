import fs from "fs";
import path from "path";

import { BuildFailedError, p } from "@hot-updater/cli-tools";
import {
  SANDBOX_INFO_PLIST_KEY,
  sandboxChannelOf,
  sandboxUrlSchemeOf,
} from "@hot-updater/protocol/native-artifact";
import { execa } from "execa";

import {
  type SandboxArchivePlan,
  sandboxVersionDecision,
} from "../sandboxTestFlight";

const URL_TYPE_NAME = "hot-updater-sandbox";

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

/** Appends a URL type with the sandbox's scheme to the app's own. */
const addUrlScheme = async (plist: string, urlScheme: string) => {
  const urlType = JSON.stringify({
    CFBundleURLName: URL_TYPE_NAME,
    CFBundleURLSchemes: [urlScheme],
  });
  const { stdout, exitCode } = await execa(
    "plutil",
    ["-extract", "CFBundleURLTypes", "json", "-o", "-", plist],
    { reject: false },
  );
  if (exitCode !== 0) {
    await plutil([
      "-insert",
      "CFBundleURLTypes",
      "-json",
      `[${urlType}]`,
      plist,
    ]);
    return;
  }
  const existing = JSON.parse(stdout) as unknown[];
  await plutil([
    "-insert",
    `CFBundleURLTypes.${existing.length}`,
    "-json",
    urlType,
    plist,
  ]);
};

/** What a dev server on this network needs: plain http to a local address, and iOS's prompt. */
const allowLocalDevServer = async (plist: string) => {
  const { exitCode } = await execa(
    "plutil",
    ["-extract", "NSAppTransportSecurity", "json", "-o", "-", plist],
    { reject: false },
  );
  if (exitCode !== 0) {
    await plutil(["-insert", "NSAppTransportSecurity", "-json", "{}", plist]);
  }
  await plutil([
    "-replace",
    "NSAppTransportSecurity.NSAllowsLocalNetworking",
    "-bool",
    "true",
    plist,
  ]);
  if ((await readValue(plist, "NSLocalNetworkUsageDescription")) === null) {
    await setString(
      plist,
      "NSLocalNetworkUsageDescription",
      "This sandbox build loads JavaScript from a dev server on your network.",
    );
  }
};

/**
 * The app's dedicated URL scheme, default channel, and the sandbox's key. The
 * URL scheme and App Store Connect's app come from the scheme's
 * `bundleIdentifier`, while Xcode's build settings decide the app's ID, so an
 * app of another ID stops here, before anything is signed or uploaded.
 */
const patchAppInfoPlist = async (
  plist: string,
  scheme: { hotUpdaterSchemeName: string; bundleIdentifier: string },
) => {
  const built = await readValue(plist, "CFBundleIdentifier");
  if (built !== scheme.bundleIdentifier) {
    throw refusal(
      `The sandbox scheme ${scheme.hotUpdaterSchemeName} sets bundleIdentifier ${scheme.bundleIdentifier}, but Xcode built ${built ?? "no bundle ID"}.\nSet bundleIdentifier to the ID its configuration builds.`,
    );
  }
  await setString(
    plist,
    "HOT_UPDATER_CHANNEL",
    sandboxChannelOf(scheme.hotUpdaterSchemeName),
  );
  await plutil(["-replace", SANDBOX_INFO_PLIST_KEY, "-bool", "true", plist]);
  await addUrlScheme(plist, sandboxUrlSchemeOf(scheme.bundleIdentifier));
  await allowLocalDevServer(plist);
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
  schemeConfig: { hotUpdaterSchemeName: string; bundleIdentifier: string };
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
  schemeConfig: { hotUpdaterSchemeName: string; bundleIdentifier: string },
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
