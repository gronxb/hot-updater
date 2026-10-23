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
