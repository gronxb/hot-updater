import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listScenarioNames } from "./scenarios.ts";
import {
  E2E_APP,
  listE2eTargets,
  loadE2eTarget,
  REPOSITORY_ROOT,
  resolveE2eTargetName,
} from "./targets.ts";

const read = (relative: string) =>
  readFileSync(path.join(REPOSITORY_ROOT, relative), "utf8");

function filesNamed(dir: string, pattern: RegExp, depth = 3): string[] {
  const absolute = path.join(REPOSITORY_ROOT, dir);
  if (!existsSync(absolute) || depth < 0) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (["Pods", "build", "node_modules", ".brownfield"].includes(entry.name))
      return [];
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return filesNamed(relative, pattern, depth - 1);
    return pattern.test(entry.name) ? [relative] : [];
  });
}

const targets = listE2eTargets();

describe("E2E targets", () => {
  it("includes the default target and the brownfield one", () => {
    expect(targets).toContain("v0.85.0");
    expect(targets).toContain("brownfield-host");
  });

  describe.each(targets)("%s", (name) => {
    const target = loadE2eTarget(name);

    it("runs a known suite", () => {
      expect(listScenarioNames(target.suite).length).toBeGreaterThan(0);
    });

    it("ships a React Native app with the shared E2E identity", () => {
      const appJson = JSON.parse(read(`${target.appDir}/app.json`)) as {
        name: string;
      };
      expect(appJson.name).toBe(E2E_APP.name);
      expect(
        existsSync(path.join(REPOSITORY_ROOT, target.appDir, "package.json")),
      ).toBe(true);
    });

    it("runs @examples/e2e-app, resolving the package's imports from the app", () => {
      const appPackage = JSON.parse(read(`${target.appDir}/package.json`)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect({
        ...appPackage.dependencies,
        ...appPackage.devDependencies,
      }).toHaveProperty("@examples/e2e-app", "workspace:*");
      expect(read(`${target.appDir}/index.js`)).toContain("registerE2eApp(");
      const configs = [
        ["rspack.config.mjs", "withE2eAppResolve("],
        ["metro.config.js", "withE2eAppResolveRequest("],
        ["jest.config.js", "@examples/e2e-app/jest-resolver"],
      ] as const;
      for (const [file, helper] of configs) {
        const relative = `${target.appDir}/${file}`;
        if (existsSync(path.join(REPOSITORY_ROOT, relative))) {
          expect(read(relative), relative).toContain(helper);
        }
      }
    });

    it("installs an Android app with the shared package and URL scheme", () => {
      const gradle = filesNamed(
        `${target.android.projectDir}/app`,
        /^build\.gradle(\.kts)?$/,
        0,
      ).map(read);
      expect(gradle.join("\n")).toMatch(
        new RegExp(`applicationId\\s*=?\\s*"${E2E_APP.androidPackage}"`),
      );
      expect(
        read(`${target.android.projectDir}/app/src/main/AndroidManifest.xml`),
      ).toContain(`android:scheme="${E2E_APP.urlScheme}"`);
    });

    it("asks for 4 KB Android pages exactly when React Native predates 16 KB support", () => {
      const appPackage = JSON.parse(read(`${target.appDir}/package.json`)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const reactNative = {
        ...appPackage.dependencies,
        ...appPackage.devDependencies,
      }["react-native"];
      // React Native 0.77 is the first release whose native libraries load
      // on a 16 KB page device without the compatibility dialog.
      const minor = Number(/^\D*0\.(\d+)\./.exec(reactNative ?? "")?.[1]);
      expect(minor).toBeGreaterThan(0);
      expect(target.android.pageSize).toBe(minor < 77 ? 4096 : undefined);
    });

    it("installs an iOS app with the shared bundle ID and URL scheme", () => {
      const projects = filesNamed(target.ios.projectDir, /^project\.pbxproj$/)
        .map(read)
        .join("\n");
      expect(
        projects.includes(
          `PRODUCT_BUNDLE_IDENTIFIER = ${E2E_APP.iosBundleId};`,
        ) ||
          (projects.includes(
            'PRODUCT_BUNDLE_IDENTIFIER = "org.reactjs.native.example.$(PRODUCT_NAME:rfc1034identifier)";',
          ) &&
            target.ios.scheme === E2E_APP.name),
      ).toBe(true);
      const plists = filesNamed(target.ios.projectDir, /^Info\.plist$/)
        .map(read)
        .join("\n");
      expect(plists).toContain(`<string>${E2E_APP.urlScheme}</string>`);
    });

    it("installs pods with the CocoaPods pnpm symlink patch", () => {
      // Without it, pod install crashes at random with "pathname contains
      // null byte" (CocoaPods/CocoaPods#12798, #12866).
      expect(read(`${target.ios.podsDir}/Podfile`)).toContain(
        "require_relative './cocoapods_pathname'",
      );
      expect(read(`${target.ios.podsDir}/cocoapods_pathname.rb`)).toBe(
        read("examples/v0.85.0/ios/cocoapods_pathname.rb"),
      );
    });
  });
});

describe("@examples/e2e-app", () => {
  it("takes React, React Native and the SDK from each target app", () => {
    const manifest = JSON.parse(read("examples/e2e-app/package.json")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    // A dependency or peer here would put a copy in the package's
    // node_modules, which a resolver can pick over the app's.
    expect(manifest.peerDependencies).toBeUndefined();
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([
      "@hot-updater/protocol",
    ]);
  });
});

describe("target selection", () => {
  it("prefers --target, then --track brownfield, then the bot's env target, then the default", () => {
    expect(resolveE2eTargetName({ target: "v0.85.0" }, {})).toBe("v0.85.0");
    expect(
      resolveE2eTargetName({}, { HOT_UPDATER_E2E_TARGET: "brownfield-host" }),
    ).toBe("brownfield-host");
    expect(resolveE2eTargetName({ track: "brownfield" }, {})).toBe(
      "brownfield-host",
    );
    expect(
      resolveE2eTargetName(
        {},
        { HOT_UPDATER_E2E_ENV_TARGET_RELATIVE_DIR: "examples/v0.85.0" },
      ),
    ).toBe("v0.85.0");
    // An env target that is no E2E target, such as an example without e2e.json.
    expect(
      resolveE2eTargetName(
        {},
        { HOT_UPDATER_E2E_ENV_TARGET_RELATIVE_DIR: "examples/expo-52" },
      ),
    ).toBe("v0.85.0");
    expect(resolveE2eTargetName({}, {})).toBe("v0.85.0");
  });

  it("refuses --track brownfield with a target that is not brownfield", () => {
    expect(() =>
      resolveE2eTargetName({ target: "v0.85.0", track: "brownfield" }, {}),
    ).toThrow("--track brownfield selects a brownfield target");
  });

  it("resolves the brownfield host's native projects and the app it packages", () => {
    const target = loadE2eTarget("brownfield-host");
    expect(target.kind).toBe("brownfield");
    expect(target.appDir).toBe("examples/v0.85.0");
    expect(target.ios.podsDir).toBe("examples/v0.85.0/ios");
    expect(target.ios.projectDir).toBe("examples/brownfield-host/ios");
    expect(target.android.apk).toBe(
      "examples/brownfield-host/android/app/build/outputs/apk/release/app-release.apk",
    );
  });
});
