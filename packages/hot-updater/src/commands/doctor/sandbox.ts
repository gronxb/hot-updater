import fs from "node:fs";
import path from "node:path";

import { findSandboxGradleBlocker } from "@hot-updater/android-helper";
import type { ConfigResponse } from "@hot-updater/cli-tools";

import { usesSwiftPackageManager } from "../../utils/native/sandbox";
import { resolveSandboxApplicationId } from "../../utils/version/getAndroidVersion";
import type { NativeCheckIssue } from "./issues";

/** Build adapters no sandbox build has run on yet. */
const UNQUALIFIED_ADAPTERS = new Set(["expo", "rock"]);

const readText = (file: string) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;

/** The package names a `google-services.json` has a client for. */
const readClientPackages = (file: string): string[] => {
  try {
    const { client } = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      client?: {
        client_info?: { android_client_info?: { package_name?: string } };
      }[];
    };
    return (client ?? []).flatMap(
      (entry) => entry.client_info?.android_client_info?.package_name ?? [],
    );
  } catch {
    return [];
  }
};

/**
 * The `google-services.json` a variant's build reads: the plugin looks in the
 * most specific source set first, and then the module's root.
 */
const findGoogleServices = (
  moduleDir: string,
  variant: string,
): string | null => {
  const words = variant
    .split(/(?=[A-Z])/u)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
  const candidates = [
    path.join("src", variant),
    ...words.map((word) => path.join("src", word)),
    ...words.map((word) => word),
    "",
  ];
  for (const candidate of candidates) {
    const file = path.join(moduleDir, candidate, "google-services.json");
    if (fs.existsSync(file)) return file;
  }
  return null;
};

/** Whether a Podfile links frameworks, without the template's `USE_FRAMEWORKS` guard. */
const linksFrameworks = (podfile: string | null) =>
  process.env["USE_FRAMEWORKS"] !== undefined ||
  (podfile !== null &&
    /^\s*use_frameworks!(?!.*:linkage\s*=>\s*linkage)/mu.test(podfile));

/** Whether the Xcode project has an app extension target. */
const hasAppExtension = (iosDir: string) =>
  fs.existsSync(iosDir) &&
  fs
    .readdirSync(iosDir)
    .filter((name) => name.endsWith(".xcodeproj"))
    .some((name) =>
      readText(path.join(iosDir, name, "project.pbxproj"))?.includes(
        "com.apple.product-type.app-extension",
      ),
    );

/**
 * Each `sandbox: true` scheme against the project: what a build would refuse,
 * a `google-services.json` with no client for the sandbox's application ID, and
 * what no sandbox build has run on yet.
 */
export const checkSandboxSchemes = async (
  config: ConfigResponse,
  cwd: string,
): Promise<NativeCheckIssue[]> => {
  const ios = Object.entries(config.nativeBuild?.ios ?? {}).filter(
    ([, scheme]) => scheme?.sandbox,
  );
  const android = Object.entries(config.nativeBuild?.android ?? {}).filter(
    ([, scheme]) => scheme?.sandbox,
  );
  if (ios.length === 0 && android.length === 0) return [];
  const issues: NativeCheckIssue[] = [];
  const unqualified = (
    platform: NativeCheckIssue["platform"],
    what: string,
  ): NativeCheckIssue => ({
    type: "warning",
    platform,
    code: "SANDBOX_UNQUALIFIED",
    message: `Sandbox builds aren't tested with ${what} yet.`,
    resolution: "Check the sandbox build on a device before you rely on it.",
  });

  const adapter = await Promise.resolve(config.build({ cwd }))
    .then(({ name }) => name)
    .catch(() => undefined);
  if (adapter && UNQUALIFIED_ADAPTERS.has(adapter)) {
    issues.push(unqualified("project", `the ${adapter} build adapter`));
  }

  const iosDir = path.join(cwd, "ios");
  if (ios.length > 0) {
    if (usesSwiftPackageManager(iosDir)) {
      issues.push({
        type: "error",
        platform: "ios",
        code: "SANDBOX_BUILD_BLOCKED",
        message: "Sandbox builds don't support Swift Package Manager yet.",
        resolution: "Build with CocoaPods, or remove sandbox: true.",
      });
    }
    if (linksFrameworks(readText(path.join(iosDir, "Podfile")))) {
      issues.push(unqualified("ios", "use_frameworks"));
    }
    if (hasAppExtension(iosDir)) {
      issues.push(unqualified("ios", "app extensions"));
    }
  }

  for (const [name, scheme] of android) {
    if (!scheme) continue;
    const blocker = findSandboxGradleBlocker(scheme);
    if (blocker) {
      const [message, resolution = ""] = blocker.split("\n");
      issues.push({
        type: "error",
        platform: "android",
        code: "SANDBOX_BUILD_BLOCKED",
        message: `${name}: ${message}`,
        resolution,
      });
    }
    const moduleDir = path.join(cwd, "android", scheme.appModuleName ?? "app");
    const googleServices = findGoogleServices(
      moduleDir,
      scheme.variant ?? "Release",
    );
    if (googleServices) {
      const applicationId = await resolveSandboxApplicationId(scheme);
      if (!readClientPackages(googleServices).includes(applicationId)) {
        issues.push({
          type: "warning",
          platform: "android",
          code: "SANDBOX_GOOGLE_SERVICES_CLIENT_MISSING",
          message: `${path.relative(cwd, googleServices)} has no client for ${applicationId}.`,
          resolution: `Add ${applicationId} to the Firebase project, then download the file again.`,
          paths: [path.relative(cwd, googleServices)],
        });
      }
    }
  }
  return issues;
};
