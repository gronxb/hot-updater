import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { maskSecretValues, registerSecretValue } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeNativeBuildKey,
  diffNativeBuildKeyComponents,
  type NativeBuildKeyComponents,
  type NativeBuildKeyInput,
} from "./buildKey";

let root: string;
let app: string;
let gradleHome: string;
let toolchain: Record<string, string>;

const write = (file: string, contents: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), contents);
};
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: "pipe" });

const input = (
  overrides: Partial<NativeBuildKeyInput> = {},
): NativeBuildKeyInput => ({
  cwd: app,
  platform: "android",
  scheme: "release",
  schemeConfig: { variant: "Release", aab: false, packageName: "com.app" },
  artifactKind: "apk",
  channel: "production",
  fingerprintHash: null,
  appVersion: "1.0.0",
  outputPath: path.join(app, ".hot-updater", "output", "build"),
  cacheDir: path.join(app, "node_modules", ".hot-updater"),
  signing: {},
  hotUpdaterVersion: "1.2.0",
  env: { GRADLE_USER_HOME: gradleHome },
  readToolchain: async () => toolchain,
  ...overrides,
});

const key = async (overrides: Partial<NativeBuildKeyInput> = {}) => {
  const result = await computeNativeBuildKey(input(overrides));
  if (result.key === null) {
    throw new Error(`uncacheable: ${result.uncacheable}`);
  }
  return result;
};

const uncacheable = async (overrides: Partial<NativeBuildKeyInput> = {}) =>
  (await computeNativeBuildKey(input(overrides))).uncacheable;

/** What changed between the key before and after `change`. */
const changedBy = async (
  change: () => void | Promise<void>,
  overrides: Partial<NativeBuildKeyInput> = {},
  after: Partial<NativeBuildKeyInput> = overrides,
) => {
  const before = await key(overrides);
  await change();
  const next = await key(after);
  return {
    changed: diffNativeBuildKeyComponents(before.components, next.components),
    same: before.key === next.key,
  };
};

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "native-build-key-")),
  );
  app = path.join(root, "apps", "mobile");
  // The machine's Gradle home, outside the repository.
  gradleHome = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "native-build-key-gradle-")),
  );
  toolchain = { jdk: "17.0.1", "android-sdk:build-tools": "36.0.0" };
  write(
    ".gitignore",
    [
      "node_modules/",
      ".env*",
      "build/",
      "local.properties",
      ".xcode.env.local",
      "GoogleService-Info.plist",
      ".hot-updater/",
      "",
    ].join("\n"),
  );
  write(
    "apps/mobile/package.json",
    JSON.stringify({
      name: "mobile",
      dependencies: { "native-lib": "1.0.0", "js-lib": "1.0.0" },
    }),
  );
  write("apps/mobile/src/App.tsx", "export const App = () => null;\n");
  write(
    "apps/mobile/android/app/build.gradle",
    [
      "def jscFlavor = 'io.github.react-native-community:jsc-android:2026004.+'",
      'def flavor = System.getenv("APP_FLAVOR")',
      'dependencies { implementation("com.facebook.react:react-android") }',
      "",
    ].join("\n"),
  );
  write("apps/mobile/ios/Podfile", "platform :ios, '15.1'\n");
  write("apps/mobile/ios/Podfile.lock", "PODS:\n  - React (0.88.0)\n");
  write("docs/README.md", "# Docs\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "init");
  // Installed after the commit: git ignores node_modules.
  write(
    "apps/mobile/node_modules/native-lib/package.json",
    JSON.stringify({ name: "native-lib", version: "1.0.0" }),
  );
  write("apps/mobile/node_modules/native-lib/android/build.gradle", "\n");
  write(
    "apps/mobile/node_modules/native-lib/android/src/Lib.kt",
    "class Lib\n",
  );
  write("apps/mobile/node_modules/native-lib/ios/Lib.m", "// lib\n");
  write("apps/mobile/node_modules/native-lib/native-lib.podspec", "\n");
  write(
    "apps/mobile/node_modules/js-lib/package.json",
    JSON.stringify({ name: "js-lib", version: "1.0.0" }),
  );
  write("apps/mobile/node_modules/js-lib/index.js", "module.exports = 1;\n");
  write("apps/mobile/node_modules/.pnpm/lock.yaml", "lockfileVersion: '9.0'\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(gradleHome, { recursive: true, force: true });
});

describe("computeNativeBuildKey", () => {
  it("computes the same key from the same inputs, with and without its hash cache", async () => {
    const first = await key();
    const second = await key();
    const uncached = await key({ cacheDir: null });

    expect(first.key).toMatch(/^nbk1:[0-9a-f]{64}$/);
    expect(second.key).toBe(first.key);
    expect(uncached.key).toBe(first.key);
  });

  it("changes with a file of the repository, whether it is staged or not", async () => {
    const edit = await changedBy(() =>
      write("apps/mobile/src/App.tsx", "export const App = () => 1;\n"),
    );
    expect(edit.changed).toEqual(["file:apps/mobile/src/App.tsx"]);

    const unstaged = await key();
    git("add", "apps/mobile/src/App.tsx");
    expect((await key()).key).toBe(unstaged.key);

    // Every file of the repository, as a commit records it.
    expect(
      (await changedBy(() => write("docs/README.md", "# Changed\n"))).changed,
    ).toEqual(["file:docs/README.md"]);
    expect(
      (await changedBy(() => write("apps/mobile/src/New.tsx", "1;\n"))).changed,
    ).toEqual(["file:apps/mobile/src/New.tsx"]);
    expect(
      (await changedBy(() => fs.rmSync(path.join(root, "docs/README.md"))))
        .changed,
    ).toEqual(["file:docs/README.md"]);
  });

  it("does not change when a file is only touched, or the CLI writes its output", async () => {
    const touched = await changedBy(() => {
      const file = path.join(app, "src/App.tsx");
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(file, later, later);
    });
    expect(touched).toEqual({ changed: [], same: true });

    const output = await changedBy(() => {
      write("apps/mobile/.hot-updater/output/build/app.apk", "apk");
      write("apps/mobile/node_modules/.hot-updater/other.json", "{}");
      write("apps/mobile/node_modules/native-lib/android/build/out.o", "o");
      write("apps/mobile/android/app/build/outputs/app.apk", "apk");
      write("apps/mobile/android/.gradle/state.bin", "s");
      write("apps/mobile/.DS_Store", "finder");
    });
    expect(output).toEqual({ changed: [], same: true });
  });

  it("changes with an input git ignores: native project files, .env files, the install state, and installed native packages", async () => {
    expect(
      (
        await changedBy(() =>
          write("apps/mobile/node_modules/native-lib/android/src/Lib.kt", "x"),
        )
      ).changed,
    ).toEqual(["input:package:native-lib@1.0.0"]);
    expect(
      (
        await changedBy(() =>
          write("apps/mobile/node_modules/.pnpm/lock.yaml", "changed: 1\n"),
        )
      ).changed,
    ).toEqual(["input:install-state:apps/mobile/node_modules/.pnpm/lock.yaml"]);
    expect(
      (await changedBy(() => write("apps/mobile/.env", "API_URL=https://a\n")))
        .changed,
    ).toEqual(["input:env-file:apps/mobile/.env"]);
    expect(
      (
        await changedBy(() =>
          write("apps/mobile/android/local.properties", "flipper=true\n"),
        )
      ).changed,
    ).toEqual(["input:local.properties"]);
    // A quoted .env value's later lines, and a properties value a
    // backslash continues.
    write("apps/mobile/.env", 'EXPO_PUBLIC_MESSAGE="first\nold"\n');
    write("apps/mobile/android/local.properties", "flags=a,\\\n  old\n");
    expect(
      (
        await changedBy(() => {
          write("apps/mobile/.env", 'EXPO_PUBLIC_MESSAGE="first\nnew"\n');
          write("apps/mobile/android/local.properties", "flags=a,\\\n  new\n");
        })
      ).changed,
    ).toEqual(["input:env-file:apps/mobile/.env", "input:local.properties"]);
    // A JavaScript-only package is a version in the lockfile, and an iOS
    // source of a native package doesn't reach an Android build.
    expect(
      await changedBy(() => {
        write("apps/mobile/node_modules/js-lib/index.js", "2;\n");
        write("apps/mobile/node_modules/native-lib/ios/Lib.m", "// 2\n");
      }),
    ).toEqual({ changed: [], same: true });
  });

  it("changes with an iOS project's ignored files and native packages", async () => {
    const ios = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app" as const,
    };
    expect(
      (
        await changedBy(
          () =>
            write("apps/mobile/ios/App/GoogleService-Info.plist", "<plist/>"),
          ios,
        )
      ).changed,
    ).toEqual(["input:file:apps/mobile/ios/App/GoogleService-Info.plist"]);
    // This machine's Node.js path, which pod install writes, but the
    // file's other settings.
    expect(
      await changedBy(
        () =>
          write(
            "apps/mobile/ios/.xcode.env.local",
            "export NODE_BINARY=/Users/me/.nvm/node\n",
          ),
        ios,
      ),
    ).toEqual({ changed: [], same: true });
    expect(
      (
        await changedBy(
          () =>
            write(
              "apps/mobile/ios/.xcode.env.local",
              "export NODE_BINARY=/Users/me/.nvm/node\nexport ENTRY_FILE=index.ios.js\n",
            ),
          ios,
        )
      ).changed,
    ).toEqual(["input:.xcode.env.local"]);
    expect(
      (
        await changedBy(
          () => write("apps/mobile/node_modules/native-lib/ios/Lib.m", "// 3"),
          ios,
        )
      ).changed,
    ).toEqual(["input:package:native-lib@1.0.0"]);
  });

  it("changes with the environment the build reads, and with nothing else in it", async () => {
    const env = (vars: Record<string, string>) => ({
      env: { GRADLE_USER_HOME: gradleHome, ...vars },
    });
    expect(
      (
        await changedBy(
          () => {},
          env({ EXPO_PUBLIC_API_URL: "https://a" }),
          env({ EXPO_PUBLIC_API_URL: "https://b" }),
        )
      ).changed,
    ).toEqual(["env:EXPO_PUBLIC_API_URL"]);
    // Read by name in android/app/build.gradle.
    expect(
      (
        await changedBy(
          () => {},
          env({ APP_FLAVOR: "a" }),
          env({ APP_FLAVOR: "b" }),
        )
      ).changed,
    ).toEqual(["env:APP_FLAVOR"]);
    // Gradle's project properties don't reach an iOS build.
    const ios = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app" as const,
    };
    expect(
      await changedBy(
        () => {},
        { ...ios, ...env({ ORG_GRADLE_PROJECT_flavor: "a" }) },
        { ...ios, ...env({ ORG_GRADLE_PROJECT_flavor: "b" }) },
      ),
    ).toEqual({ changed: [], same: true });
    // Credentials, and a variable no build input reads.
    const credentials = (value: string) =>
      env({
        HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD: value,
        HOT_UPDATER_API_KEY: value,
        HOT_UPDATER_BUNDLE_SIGNING_KEY: value,
        HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING: value,
        HOT_UPDATER_VERCEL_DATABASE_URL: value,
        HOT_UPDATER_CONSOLE_SESSION: value,
        HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON: value,
        UNRELATED: value,
      });
    expect(
      await changedBy(() => {}, credentials("a"), credentials("b")),
    ).toEqual({ changed: [], same: true });
    // A public value the app bundles keys the build, whatever its name.
    expect(
      (
        await changedBy(
          () => {},
          env({ EXPO_PUBLIC_MAPS_API_KEY: "a" }),
          env({ EXPO_PUBLIC_MAPS_API_KEY: "b" }),
        )
      ).changed,
    ).toEqual(["env:EXPO_PUBLIC_MAPS_API_KEY"]);
  });

  it("reads the environment variables a generated native project reads", async () => {
    // As an Expo app's: android/ is generated and ignored.
    write(
      ".gitignore",
      `${fs.readFileSync(path.join(root, ".gitignore"))}apps/mobile/android/\n`,
    );
    git("rm", "-rq", "--cached", "apps/mobile/android");
    write(
      "apps/mobile/android/settings.gradle",
      'def community = System.getenv("EXPO_USE_COMMUNITY_AUTOLINKING")\n',
    );
    const env = (value: string) => ({
      env: {
        GRADLE_USER_HOME: gradleHome,
        EXPO_USE_COMMUNITY_AUTOLINKING: value,
      },
    });
    expect((await changedBy(() => {}, env("0"), env("1"))).changed).toEqual([
      "env:EXPO_USE_COMMUNITY_AUTOLINKING",
    ]);
    write(
      "apps/mobile/android/app/build.gradle",
      'dependencies { implementation("com.example:lib:+") }\n',
    );
    expect(await uncacheable()).toBe(
      "android/app/build.gradle declares a dynamic dependency version without a gradle.lockfile, so Gradle may resolve another version on each build",
    );
    write("apps/mobile/android/app/build.gradle", "System.getenv(name)\n");
    expect(await uncacheable()).toBe(
      "android/app/build.gradle reads environment variables by a computed name, which no key can follow",
    );
  });

  it("changes with what the build embeds and how the scheme builds it", async () => {
    const base = await key();
    const changes = async (overrides: Partial<NativeBuildKeyInput>) =>
      diffNativeBuildKeyComponents(
        base.components,
        (await key(overrides)).components,
      );

    expect(await changes({ channel: "beta" })).toEqual(["setting:channel"]);
    expect(await changes({ appVersion: "1.0.1" })).toEqual([
      "setting:app-version",
    ]);
    expect(await changes({ fingerprintHash: "fp", appVersion: null })).toEqual([
      "setting:app-version",
      "setting:fingerprint",
    ]);
    expect(await changes({ artifactKind: "aab" })).toEqual([
      "setting:artifact",
    ]);
    expect(
      await changes({
        schemeConfig: {
          variant: "Release",
          aab: false,
          packageName: "com.app",
          appModuleName: "app2",
        },
      }),
    ).toEqual(["setting:scheme"]);
    expect(await changes({ hotUpdaterVersion: "1.2.1" })).toEqual([
      "toolchain:hot-updater",
    ]);
    toolchain = { ...toolchain, jdk: "21.0.1" };
    expect(await changes({})).toEqual(["toolchain:jdk"]);
  });

  it("changes with the App Store Connect API key that signs, never with its secret", async () => {
    const device = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: false },
      artifactKind: "ipa" as const,
    };
    const signedBy = (keyId: string) => ({
      ...device,
      signing: { ascApiKey: { keyId, issuerId: "issuer" } },
    });
    expect(
      (await changedBy(() => {}, signedBy("KEY1"), signedBy("KEY2"))).changed,
    ).toEqual(["signing:asc-api-key"]);
  });

  it("changes with a file the scheme names", async () => {
    write("apps/mobile/ios/Release.xcconfig", "A = 1\n");
    write(
      "apps/mobile/ios/ExportOptions.plist",
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>method</key><string>app-store-connect</string></dict></plist>`,
    );
    const device = {
      platform: "ios" as const,
      schemeConfig: {
        configuration: "Release",
        simulator: false,
        xcconfig: "ios/Release.xcconfig",
        exportOptionsPlist: path.join(app, "ios/ExportOptions.plist"),
      },
      artifactKind: "ipa" as const,
    };
    // The xcconfig is a file of the repository too.
    expect(
      (
        await changedBy(
          () => write("apps/mobile/ios/Release.xcconfig", "A = 2\n"),
          device,
        )
      ).changed,
    ).toEqual([
      "file:apps/mobile/ios/Release.xcconfig",
      "setting:file:xcconfig",
    ]);
  });

  it("keeps secrets and this machine's directories out of the key and its components", async () => {
    const secret = "hunter2-native-build-secret";
    registerSecretValue(secret);
    write("apps/mobile/.env", `API_TOKEN=${secret}\nPUBLIC=${secret}\n`);
    write(
      "apps/mobile/android/local.properties",
      `sdk.dir=${os.homedir()}/sdk\nstorePassword=${secret}\n`,
    );
    fs.writeFileSync(
      path.join(gradleHome, "gradle.properties"),
      `MYAPP_STORE_PASSWORD=${secret}\norg.gradle.java.home=${root}/jdk\n`,
    );
    const withSecret = await key({
      env: {
        GRADLE_USER_HOME: gradleHome,
        EXPO_PUBLIC_VALUE: secret,
        HOT_UPDATER_E2E_DIR: `${root}/e2e`,
        RCT_HOME: os.homedir(),
      },
    });
    const preimage = JSON.stringify(withSecret.components);

    expect(maskSecretValues(preimage)).toBe(preimage);
    expect(preimage).not.toContain(root);
    expect(preimage).not.toContain(os.homedir());
    expect(preimage).not.toContain(os.tmpdir());

    // A changed secret leaves the key as it was.
    const other = "hunter3-native-build-secret";
    registerSecretValue(other);
    write("apps/mobile/.env", `API_TOKEN=${other}\nPUBLIC=${other}\n`);
    write(
      "apps/mobile/android/local.properties",
      `sdk.dir=/elsewhere/sdk\nstorePassword=${other}\n`,
    );
    fs.writeFileSync(
      path.join(gradleHome, "gradle.properties"),
      `MYAPP_STORE_PASSWORD=${other}\norg.gradle.java.home=${root}/jdk\n`,
    );
    const withOther = await key({
      env: {
        GRADLE_USER_HOME: gradleHome,
        EXPO_PUBLIC_VALUE: other,
        HOT_UPDATER_E2E_DIR: `${root}/e2e`,
        RCT_HOME: os.homedir(),
      },
    });
    expect(
      diffNativeBuildKeyComponents(withSecret.components, withOther.components),
    ).toEqual([]);
    expect(withOther.key).toBe(withSecret.key);
  });
});

describe("builds no key covers", () => {
  it("refuses a Debug build, and a project outside git", async () => {
    expect(
      await uncacheable({
        schemeConfig: { variant: "Debug", aab: false, packageName: "x" },
      }),
    ).toBe("a Debug build loads its JavaScript from Metro");
    fs.rmSync(path.join(root, ".git"), { recursive: true });
    expect(await uncacheable()).toBe("the project is not in a git repository");
  });

  it("refuses pods without Podfile.lock", async () => {
    fs.rmSync(path.join(app, "ios/Podfile.lock"));
    expect(
      await uncacheable({
        platform: "ios",
        schemeConfig: { configuration: "Release", simulator: true },
        artifactKind: "app",
      }),
    ).toBe(
      "ios/Podfile.lock is missing, so the pods resolve anew on each install",
    );
  });

  it("refuses Swift packages without Package.resolved", async () => {
    write(
      "apps/mobile/ios/App.xcodeproj/project.pbxproj",
      "/* XCRemoteSwiftPackageReference */\n",
    );
    const ios = {
      platform: "ios" as const,
      schemeConfig: { configuration: "Release", simulator: true },
      artifactKind: "app" as const,
    };
    expect(await uncacheable(ios)).toBe(
      "ios/App.xcodeproj/project.pbxproj uses Swift packages without a Package.resolved, so they resolve anew on each build",
    );
    write(
      "apps/mobile/ios/App.xcworkspace/xcshareddata/swiftpm/Package.resolved",
      "{}",
    );
    expect(await uncacheable(ios)).toBeNull();
  });

  it("refuses a dynamic Gradle dependency version without a gradle.lockfile", async () => {
    // The template's jscFlavor variable is no dependency.
    expect(await uncacheable()).toBeNull();
    write(
      "apps/mobile/android/app/build.gradle",
      'dependencies { implementation("com.example:lib:1.+") }\n',
    );
    expect(await uncacheable()).toBe(
      "android/app/build.gradle declares a dynamic dependency version without a gradle.lockfile, so Gradle may resolve another version on each build",
    );
    write("apps/mobile/android/app/gradle.lockfile", "com.example:lib:1.2=x\n");
    expect(await uncacheable()).toBeNull();
  });

  it("refuses environment reads by a computed name", async () => {
    write(
      "apps/mobile/android/app/build.gradle",
      "def value = System.getenv(name)\n",
    );
    expect(await uncacheable()).toBe(
      "android/app/build.gradle reads environment variables by a computed name, which no key can follow",
    );
    write("apps/mobile/android/app/build.gradle", "\n");
    write("apps/mobile/ios/Podfile", "ENV.each { |k, v| puts k }\n");
    expect(
      await uncacheable({
        platform: "ios",
        schemeConfig: { configuration: "Release", simulator: true },
        artifactKind: "app",
      }),
    ).toBe(
      "ios/Podfile reads environment variables by a computed name, which no key can follow",
    );
  });

  it("refuses export methods that sign for a device list, and profiles not on this machine", async () => {
    const exportOptions = (dict: string) => {
      write(
        "apps/mobile/ios/ExportOptions.plist",
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${dict}</dict></plist>`,
      );
      return {
        platform: "ios" as const,
        schemeConfig: {
          configuration: "Release",
          simulator: false,
          exportOptionsPlist: path.join(app, "ios/ExportOptions.plist"),
        },
        artifactKind: "ipa" as const,
      };
    };
    expect(
      await uncacheable(
        exportOptions("<key>method</key><string>release-testing</string>"),
      ),
    ).toBe(
      "the export method release-testing signs for a list of devices, which changes outside the project",
    );
    expect(
      await uncacheable(
        exportOptions(
          "<key>method</key><string>app-store-connect</string><key>signingStyle</key><string>manual</string><key>provisioningProfiles</key><dict><key>com.app</key><string>No Such Profile 9f2c</string></dict>",
        ),
      ),
    ).toBe(
      "the provisioning profile No Such Profile 9f2c for com.app is not installed on this machine",
    );
  });

  it("refuses an Android keystore whose certificate keytool can't read", async () => {
    expect(
      await uncacheable({
        signing: {
          androidKeystore: {
            storeFile: path.join(root, "missing.jks"),
            storePassword: "unused",
            keyAlias: "upload",
          },
        },
      }),
    ).toMatch(/^the release keystore's certificate could not be read/);
  });
});

describe("diffNativeBuildKeyComponents", () => {
  it("names what changed by component, and an engine change alone", () => {
    const components: NativeBuildKeyComponents = {
      engine: "e1",
      files: { "a.ts": "1" },
      inputs: {},
      settings: { channel: "production" },
      signing: {},
      toolchain: {},
      env: { A: "1" },
    };
    expect(
      diffNativeBuildKeyComponents(components, {
        ...components,
        files: { "b.ts": "1" },
        env: {},
      }),
    ).toEqual(["file:a.ts", "file:b.ts", "env:A"]);
    expect(
      diffNativeBuildKeyComponents(components, { ...components, engine: "e2" }),
    ).toEqual(["engine"]);
  });
});
