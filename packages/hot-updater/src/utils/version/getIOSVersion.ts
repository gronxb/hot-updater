import fs from "fs/promises";
import path from "path";

import { XcodeProject } from "@bacons/xcode";
import { getCwd } from "@hot-updater/cli-tools";
import fg from "fast-glob";

import { parsePlist } from "../configParser/plistUtils";
import { getIosAppTargetDirectoryName } from "../getIosAppTargetDirectoryName";
import {
  type AppVersionCandidate,
  type ResolvedAppVersion,
  resolveFromCandidates,
} from "./appVersionCandidates";

/** The native build scheme an iOS version is read for. */
export interface IOSAppVersionScope {
  /** The Xcode scheme, matched against the app target's name. */
  scheme?: string;
  bundleIdentifier?: string;
  /** @default "Release" */
  configuration?: string;
}

const isFileExist = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};

// Xcode substitutes both $(NAME) and ${NAME}.
const isResolved = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("$(") &&
  !value.includes("${");

const readInfoPlistVersion = async (
  plistPath: string,
): Promise<string | null> => {
  try {
    if (!(await isFileExist(plistPath))) return null;

    const fileBuffer = await fs.readFile(plistPath);
    const data = parsePlist(fileBuffer);
    const appVersion = data["CFBundleShortVersionString"];

    return isResolved(appVersion) ? appVersion : null;
  } catch {
    return null;
  }
};

const getIOSVersionFromInfoPlist = async (): Promise<string | null> => {
  const iosAppTargetDirectory = getIosAppTargetDirectoryName();
  if (!iosAppTargetDirectory) return null;

  return readInfoPlistVersion(
    path.join(getCwd(), "ios", iosAppTargetDirectory, "Info.plist"),
  );
};

type XcodeObject = {
  isa?: string;
  name?: string;
  productType?: string;
  targets?: string[];
  buildConfigurationList?: string;
  buildConfigurations?: string[];
  buildSettings?: {
    MARKETING_VERSION?: unknown;
    PRODUCT_BUNDLE_IDENTIFIER?: unknown;
    INFOPLIST_FILE?: unknown;
  };
};

const APPLICATION_PRODUCT_TYPE = "com.apple.product-type.application";

/**
 * Reads MARKETING_VERSION per application target, so a project whose targets
 * (brands, environments) ship different versions is reported as ambiguous
 * instead of resolving to whichever configuration comes first in the file.
 */
const getIOSVersionFromXcodeProject = async (
  scope: IOSAppVersionScope = {},
): Promise<ResolvedAppVersion> => {
  const notFound: ResolvedAppVersion = { version: null, candidates: [] };
  try {
    const iosDirectory = path.join(getCwd(), "ios");
    const [xcodeprojPath] = fg.globSync("*.xcodeproj/project.pbxproj", {
      cwd: iosDirectory,
      absolute: true,
      onlyFiles: true,
    });

    if (!xcodeprojPath) {
      return notFound;
    }

    const project = XcodeProject.open(xcodeprojPath).toJSON();
    const objects = (project.objects ?? {}) as Record<
      string,
      XcodeObject | undefined
    >;
    const configurationName = scope.configuration ?? "Release";

    const findConfiguration = (listId: string | undefined) =>
      (listId ? (objects[listId]?.buildConfigurations ?? []) : [])
        .map((id) => objects[id])
        .find((config) => config?.name === configurationName);

    const rootProject = project.rootObject
      ? objects[project.rootObject]
      : undefined;
    const projectSettings =
      findConfiguration(rootProject?.buildConfigurationList)?.buildSettings ??
      {};

    const appTargets = (rootProject?.targets ?? [])
      .map((id) => objects[id])
      .filter(
        (target): target is XcodeObject =>
          target?.isa === "PBXNativeTarget" &&
          target.productType === APPLICATION_PRODUCT_TYPE,
      )
      .map((target) => {
        // A target inherits what its own configuration leaves unset from the
        // project's configuration of the same name.
        const settings = {
          ...projectSettings,
          ...findConfiguration(target.buildConfigurationList)?.buildSettings,
        };
        const infoPlistFile =
          typeof settings.INFOPLIST_FILE === "string"
            ? settings.INFOPLIST_FILE.replace("$(SRCROOT)", iosDirectory)
            : undefined;
        return {
          name: target.name ?? "unknown",
          bundleIdentifier: settings.PRODUCT_BUNDLE_IDENTIFIER,
          marketingVersion: settings.MARKETING_VERSION,
          infoPlistPath: isResolved(infoPlistFile)
            ? path.resolve(iosDirectory, infoPlistFile)
            : undefined,
        };
      });

    if (appTargets.length === 0) {
      // No application target to scope by: every configuration of that name.
      const candidates = Object.values(objects)
        .filter(
          (object) =>
            object?.isa === "XCBuildConfiguration" &&
            object.name === configurationName &&
            object.buildSettings?.MARKETING_VERSION !== undefined,
        )
        .map((object) => ({
          label: configurationName,
          version: isResolved(object?.buildSettings?.MARKETING_VERSION)
            ? object.buildSettings.MARKETING_VERSION
            : null,
        }));
      return resolveFromCandidates(candidates);
    }

    const scopedTargets =
      scope.scheme || scope.bundleIdentifier
        ? appTargets.filter(
            (target) =>
              target.name === scope.scheme ||
              (scope.bundleIdentifier !== undefined &&
                target.bundleIdentifier === scope.bundleIdentifier),
          )
        : [];
    const targets = scopedTargets.length > 0 ? scopedTargets : appTargets;

    return resolveFromCandidates(
      await Promise.all(
        targets.map(
          async (target): Promise<AppVersionCandidate> => ({
            label: `${target.name} (${configurationName})`,
            // A literal CFBundleShortVersionString is what the built app
            // reports, over MARKETING_VERSION.
            version:
              (target.infoPlistPath
                ? await readInfoPlistVersion(target.infoPlistPath)
                : null) ??
              (isResolved(target.marketingVersion)
                ? target.marketingVersion
                : null),
          }),
        ),
      ),
    );
  } catch {
    return notFound;
  }
};

/**
 * The iOS app version: Info.plist first, project.pbxproj as a fallback.
 *
 * CFBundleShortVersionString is the version the built app actually reports,
 * so it is the more correct source (#84). It is also far cheaper: reading
 * Info.plist is a small file read, whereas the pbxproj parser is synchronous
 * and blocks the event loop for the length of the parse. On a large
 * project.pbxproj that can take minutes. The React Native template ships
 * Info.plist with CFBundleShortVersionString set to "$(MARKETING_VERSION)",
 * which the plist parser cannot resolve, so the real version only lives in
 * project.pbxproj for most projects.
 */
export const resolveIOSAppVersion = async (
  scope?: IOSAppVersionScope,
  baseVersion?: string,
): Promise<ResolvedAppVersion> => {
  // A prebuild writes the base version into the app's Info.plist, which is
  // read before the Xcode project.
  const plistVersion = baseVersion ?? (await getIOSVersionFromInfoPlist());
  if (plistVersion) {
    return {
      version: plistVersion,
      candidates: [{ label: "Info.plist", version: plistVersion }],
    };
  }

  return getIOSVersionFromXcodeProject(scope);
};
