import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  NativeFingerprint,
  NativeFingerprintOptions,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Lynx native fingerprint", () => {
  let cwd: string;
  let packageRoot: string;
  // Resolve the temporary app with Node, excluding the test runner's
  // NODE_PATH fallback to every workspace dependency.
  const createFingerprint = async (
    options: NativeFingerprintOptions,
  ): Promise<NativeFingerprint> => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { lynx } from "@hot-updater/lynx-build";
        const [cwd, options] = JSON.parse(process.argv[1]);
        const adapter = lynx({ build: async () => { throw new Error("Compiler must not run during fingerprinting"); } })({ cwd });
        console.log(JSON.stringify(await adapter.nativeBuild.fingerprint(options)));
      `,
        JSON.stringify([cwd, options]),
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, NODE_PATH: "" },
      },
    );
    return JSON.parse(stdout);
  };

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-fingerprint-"));
    packageRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "lynx-package-fingerprint-"),
    );
    await fs.mkdir(path.join(cwd, "node_modules/@hot-updater"), {
      recursive: true,
    });
    await fs.symlink(
      packageRoot,
      path.join(cwd, "node_modules/@hot-updater/lynx"),
    );
    await fs.mkdir(path.join(cwd, "ios"));
    await fs.mkdir(path.join(cwd, "android"));
    await fs.writeFile(path.join(cwd, "ios", "Podfile.lock"), "Lynx 1.0");
    await fs.writeFile(
      path.join(cwd, "android", "build.gradle.kts"),
      "lynx=1.0",
    );
    await fs.writeFile(
      path.join(cwd, "package.json"),
      '{"dependencies":{"@lynx-js/react":"1.0.0"}}',
    );
    await fs.mkdir(
      path.join(packageRoot, "ios", "Sources", "HotUpdaterLynxArtifact"),
      {
        recursive: true,
      },
    );
    await fs.mkdir(path.join(packageRoot, "android", "src", "main", "java"), {
      recursive: true,
    });
    await fs.mkdir(path.join(packageRoot, "android", "libs"));
    await fs.writeFile(path.join(packageRoot, "package.json"), "{}");
    await fs.writeFile(
      path.join(packageRoot, "ios", "Package.swift"),
      "package",
    );
    await fs.writeFile(
      path.join(
        packageRoot,
        "ios",
        "Sources",
        "HotUpdaterLynxArtifact",
        "Host.swift",
      ),
      "struct Host {}",
    );
    await fs.writeFile(
      path.join(packageRoot, "android", "build.gradle"),
      "android {}",
    );
    await fs.writeFile(
      path.join(packageRoot, "android", "src", "main", "java", "Host.kt"),
      "class Host",
    );
    await fs.writeFile(
      path.join(packageRoot, "android", "libs", "native.jar"),
      "binary-a",
    );
  });

  afterEach(async () => {
    await Promise.all([
      fs.rm(cwd, { recursive: true, force: true }),
      fs.rm(packageRoot, { recursive: true, force: true }),
    ]);
  });

  it("changes when the selected platform native inputs change", async () => {
    const before = await createFingerprint({ platform: "ios" });
    await fs.writeFile(path.join(cwd, "ios", "Podfile.lock"), "Lynx 2.0");
    const after = await createFingerprint({ platform: "ios" });
    expect(after.hash).not.toBe(before.hash);
  });

  it("normalizes only the injected Android fingerprint value", async () => {
    const manifest = path.join(
      cwd,
      "android",
      "app",
      "src",
      "main",
      "AndroidManifest.xml",
    );
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    const writeManifest = (fingerprint: string, label: string) =>
      fs.writeFile(
        manifest,
        `<manifest><application android:label="${label}"><meta-data\n android:value="${fingerprint}"\n android:name='com.hotupdater.FINGERPRINT_HASH'/></application></manifest>`,
      );
    await writeManifest("fingerprint-a", "App");
    const before = await createFingerprint({
      platform: "android",
    });
    await writeManifest("fingerprint-b", "App");
    const reinjected = await createFingerprint({
      platform: "android",
    });
    expect(reinjected.hash).toBe(before.hash);
    expect(reinjected.sources).toEqual(before.sources);

    await writeManifest("fingerprint-b", "Changed App");
    const changed = await createFingerprint({
      platform: "android",
    });
    expect(changed.hash).not.toBe(before.hash);
  });

  it("normalizes only the injected iOS fingerprint value", async () => {
    const plist = path.join(cwd, "ios", "Info.plist");
    const writePlist = (fingerprint: string, displayName: string) =>
      fs.writeFile(
        plist,
        `<plist><dict><key>HOT_UPDATER_FINGERPRINT_HASH</key>\n<string>${fingerprint}</string><key>CFBundleDisplayName</key><string>${displayName}</string></dict></plist>`,
      );
    await writePlist("fingerprint-a", "App");
    const before = await createFingerprint({ platform: "ios" });
    await writePlist("fingerprint-b", "App");
    const reinjected = await createFingerprint({
      platform: "ios",
    });
    expect(reinjected.hash).toBe(before.hash);
    expect(reinjected.sources).toEqual(before.sources);

    await writePlist("fingerprint-b", "Changed App");
    const changed = await createFingerprint({
      platform: "ios",
    });
    expect(changed.hash).not.toBe(before.hash);
  });

  it("normalizes the post-fingerprint native trust-anchor injection", async () => {
    const iosPlist = path.join(cwd, "ios", "Info.plist");
    const androidManifest = path.join(
      cwd,
      "android",
      "app",
      "src",
      "main",
      "AndroidManifest.xml",
    );
    await fs.mkdir(path.dirname(androidManifest), { recursive: true });
    await Promise.all([
      fs.writeFile(
        iosPlist,
        "<plist><dict><key>HOT_UPDATER_FINGERPRINT_HASH</key><string>hash</string></dict></plist>",
      ),
      fs.writeFile(
        androidManifest,
        '<manifest><application><meta-data android:name="com.hotupdater.FINGERPRINT_HASH" android:value="hash"/></application></manifest>',
      ),
    ]);
    const iosBefore = await createFingerprint({ platform: "ios" });
    const androidBefore = await createFingerprint({ platform: "android" });

    await Promise.all([
      fs.writeFile(
        iosPlist,
        "<plist>\n  <dict>\n    <key>HOT_UPDATER_FINGERPRINT_HASH</key><string>hash</string>\n    <key>HOT_UPDATER_PUBLIC_KEY</key><string>key-b</string>\n  </dict>\n</plist>\n",
      ),
      fs.writeFile(
        androidManifest,
        '<manifest>\n  <application>\n    <meta-data android:name="com.hotupdater.FINGERPRINT_HASH" android:value="hash"/>\n    <meta-data android:name="com.hotupdater.PUBLIC_KEY" android:value="key-b"/>\n  </application>\n</manifest>\n',
      ),
    ]);

    await expect(createFingerprint({ platform: "ios" })).resolves.toEqual(
      iosBefore,
    );
    await expect(createFingerprint({ platform: "android" })).resolves.toEqual(
      androidBefore,
    );
  });

  it.each([
    [
      "large integers",
      "<integer>9007199254740992</integer>",
      "<integer>9007199254740993</integer>",
    ],
    ["whitespace strings", "<string> </string>", "<string>  </string>"],
    ["native data", "<data>AQI=</data>", "<data>AQM=</data>"],
    [
      "array order",
      "<array><string>A</string><integer>1</integer><string>B</string></array>",
      "<array><string>A</string><string>B</string><integer>1</integer></array>",
    ],
    [
      "nested settings",
      "<dict><key>HOT_UPDATER_FINGERPRINT_HASH</key><string>A</string></dict>",
      "<dict><key>HOT_UPDATER_FINGERPRINT_HASH</key><string>B</string></dict>",
    ],
  ])("preserves native plist differences in %s", async (_, first, second) => {
    const plist = path.join(cwd, "ios", "Info.plist");
    const writeValue = (value: string) =>
      fs.writeFile(
        plist,
        `<plist><dict><key>NativeSetting</key>${value}</dict></plist>`,
      );
    await writeValue(first);
    const before = await createFingerprint({ platform: "ios" });
    await writeValue(second);
    expect((await createFingerprint({ platform: "ios" })).hash).not.toBe(
      before.hash,
    );
  });

  it("preserves significant Android route whitespace", async () => {
    const manifest = path.join(cwd, "android/app/src/main/AndroidManifest.xml");
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    const writeRoute = (route: string) =>
      fs.writeFile(
        manifest,
        `<manifest><application><activity android:name=".Main"><intent-filter><data android:path="${route}"/></intent-filter></activity></application></manifest>`,
      );
    await writeRoute("/route ");
    const before = await createFingerprint({ platform: "android" });
    expect(
      before.sources.some(
        (source) =>
          source.type === "file" &&
          source.filePath === "android/app/src/main/AndroidManifest.xml",
      ),
    ).toBe(true);
    await writeRoute("/route");
    expect((await createFingerprint({ platform: "android" })).hash).not.toBe(
      before.hash,
    );
  });

  it("keeps binary native plists hash-sensitive without XML decoding", async () => {
    const plist = path.join(cwd, "ios", "NativeSettings.plist");
    // Valid binary plists containing { NativeSetting: 1 } and { NativeSetting: 2 }.
    await fs.writeFile(
      plist,
      Buffer.from(
        "YnBsaXN0MDDRAQJdTmF0aXZlU2V0dGluZxABCAsZAAAAAAAAAQEAAAAAAAAAAwAAAAAAAAAAAAAAAAAAABs=",
        "base64",
      ),
    );
    const before = await createFingerprint({ platform: "ios" });
    await fs.writeFile(
      plist,
      Buffer.from(
        "YnBsaXN0MDDRAQJdTmF0aXZlU2V0dGluZxACCAsZAAAAAAAAAQEAAAAAAAAAAwAAAAAAAAAAAAAAAAAAABs=",
        "base64",
      ),
    );
    expect((await createFingerprint({ platform: "ios" })).hash).not.toBe(
      before.hash,
    );
  });

  it.each(["utf16le", "latin1"] as const)(
    "preserves distinct native values in %s XML",
    async (encoding) => {
      const file = path.join(cwd, "ios", "Settings.plist");
      const writeValue = async (value: string) => {
        const declaration = encoding === "utf16le" ? "UTF-16" : "ISO-8859-1";
        const xml = `<?xml version="1.0" encoding="${declaration}"?><plist><dict><key>NativeSetting</key><string>${value}</string></dict></plist>`;
        const bytes = Buffer.from(xml, encoding);
        await fs.writeFile(
          file,
          encoding === "utf16le"
            ? Buffer.concat([Buffer.from([0xff, 0xfe]), bytes])
            : bytes,
        );
      };
      await writeValue("café");
      const before = await createFingerprint({ platform: "ios" });
      await writeValue("cafê");
      expect((await createFingerprint({ platform: "ios" })).hash).not.toBe(
        before.hash,
      );
    },
  );

  it("retains declarations that change the meaning of encoded XML bytes", async () => {
    const file = path.join(cwd, "ios", "Settings.plist");
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>NativeSetting</key><string>é</string></dict></plist>';
    await fs.writeFile(file, xml);
    const before = await createFingerprint({ platform: "ios" });
    // The same payload bytes mean two different strings under these encodings.
    await fs.writeFile(
      file,
      xml.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'),
    );
    expect((await createFingerprint({ platform: "ios" })).hash).not.toBe(
      before.hash,
    );
  });

  it("does not include the other platform or generated dependency trees", async () => {
    const before = await createFingerprint({
      platform: "android",
    });
    await fs.writeFile(path.join(cwd, "ios", "Podfile.lock"), "Lynx 2.0");
    await fs.mkdir(path.join(cwd, "android", "build"));
    await fs.writeFile(path.join(cwd, "android", "build", "output"), "new");
    const after = await createFingerprint({
      platform: "android",
    });
    expect(after.hash).toBe(before.hash);
  });

  it("excludes repository metadata but includes native build inputs", async () => {
    const baseline = await createFingerprint({
      platform: "ios",
    });
    await Promise.all([
      fs.writeFile(path.join(cwd, "ios", "README.md"), "documentation"),
      fs.writeFile(path.join(cwd, "ios", ".gitignore"), "generated"),
      fs.writeFile(path.join(cwd, "ios", ".swiftlint.yml"), "rules"),
      fs.writeFile(path.join(cwd, "ios", ".clang-format"), "formatting"),
      fs.writeFile(path.join(cwd, "ios", "Gemfile"), "tooling"),
      fs.writeFile(path.join(cwd, "ios", "bootstrap.sh"), "tooling"),
    ]);
    const metadataChanged = await createFingerprint({
      platform: "ios",
    });
    expect(metadataChanged).toEqual(baseline);

    const source = path.join(cwd, "ios", "App.swift");
    await fs.writeFile(source, "struct App {};");
    const sourceChanged = await createFingerprint({
      platform: "ios",
    });
    expect(sourceChanged.hash).not.toBe(baseline.hash);
    await fs.rm(source);

    const assets = path.join(cwd, "ios", "Assets.xcassets");
    await fs.mkdir(assets);
    await fs.writeFile(path.join(assets, "Contents.json"), "{}");
    const resourceChanged = await createFingerprint({
      platform: "ios",
    });
    expect(resourceChanged.hash).not.toBe(baseline.hash);
    await fs.rm(assets, { recursive: true });

    await fs.writeFile(
      path.join(cwd, "package.json"),
      '{"dependencies":{"@lynx-js/react":"2.0.0"}}',
    );
    const dependencyChanged = await createFingerprint({
      platform: "ios",
    });
    expect(dependencyChanged.hash).not.toBe(baseline.hash);
  });

  it("excludes Android repository metadata and bootstrap tooling", async () => {
    const baseline = await createFingerprint({
      platform: "android",
    });
    await Promise.all([
      fs.writeFile(path.join(cwd, "android", "README.md"), "documentation"),
      fs.writeFile(path.join(cwd, "android", ".gitignore"), "generated"),
      fs.writeFile(path.join(cwd, "android", ".editorconfig"), "formatting"),
      fs.writeFile(path.join(cwd, "android", "gradlew"), "bootstrap tooling"),
    ]);
    const metadataChanged = await createFingerprint({
      platform: "android",
    });
    expect(metadataChanged).toEqual(baseline);

    const source = path.join(cwd, "android", "app", "src", "main", "App.kt");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "class App");
    const sourceChanged = await createFingerprint({
      platform: "android",
    });
    expect(sourceChanged.hash).not.toBe(baseline.hash);
  });

  it("includes package native sources but excludes package documentation", async () => {
    const baseline = await createFingerprint({ platform: "ios" });
    await fs.writeFile(
      path.join(packageRoot, "ios", "README.md"),
      "documentation",
    );
    const documented = await createFingerprint({ platform: "ios" });
    expect(documented).toEqual(baseline);

    await fs.writeFile(
      path.join(
        packageRoot,
        "ios",
        "Sources",
        "HotUpdaterLynxArtifact",
        "Host.swift",
      ),
      "struct Host { let revision = 2 }",
    );
    const sourceChanged = await createFingerprint({ platform: "ios" });
    expect(sourceChanged.hash).not.toBe(baseline.hash);
    expect(
      sourceChanged.sources.some(
        (source) =>
          "filePath" in source &&
          source.filePath ===
            "@hot-updater/lynx/ios/Sources/HotUpdaterLynxArtifact/Host.swift",
      ),
    ).toBe(true);
  });

  it("includes package Android source and binary dependencies", async () => {
    const baseline = await createFingerprint({ platform: "android" });
    await fs.writeFile(
      path.join(packageRoot, "android", "README.md"),
      "documentation",
    );
    expect(await createFingerprint({ platform: "android" })).toEqual(baseline);

    const source = path.join(
      packageRoot,
      "android",
      "src",
      "main",
      "java",
      "Host.kt",
    );
    await fs.writeFile(source, "class HostV2");
    expect((await createFingerprint({ platform: "android" })).hash).not.toBe(
      baseline.hash,
    );

    await fs.writeFile(source, "class Host");
    await fs.writeFile(
      path.join(packageRoot, "android", "libs", "native.jar"),
      "binary-b",
    );
    expect((await createFingerprint({ platform: "android" })).hash).not.toBe(
      baseline.hash,
    );
  });

  it("invalidates Android compatibility when the Fresco adaptation changes", async () => {
    const lynxRoot = path.join(cwd, "node_modules/@hot-updater/lynx");
    const directory = path.join(lynxRoot, "android");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(lynxRoot, "package.json"), "{}");
    const adapter = path.join(directory, "fresco-compat.gradle");
    await fs.writeFile(adapter, "sourceChecksum = 'revision-a'");
    const before = await createFingerprint({ platform: "android" });
    await fs.writeFile(adapter, "sourceChecksum = 'revision-b'");
    const after = await createFingerprint({ platform: "android" });

    expect(after.hash).not.toBe(before.hash);
    expect(after.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: "@hot-updater/lynx/android/fresco-compat.gradle",
        }),
      ]),
    );
  });

  it("hashes an installed Sparkling host without making it required for other hosts", async () => {
    const withoutSparkling = await createFingerprint({ platform: "ios" });
    expect(
      withoutSparkling.sources.some(
        (source) =>
          "filePath" in source &&
          source.filePath.startsWith("@hot-updater/lynx-sparkling/"),
      ),
    ).toBe(false);
    const sparklingRoot = path.join(
      cwd,
      "node_modules/@hot-updater/lynx-sparkling",
    );
    const source = path.join(
      sparklingRoot,
      "ios/Sources/HotUpdaterLynxSparkling/Host.swift",
    );
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(path.join(sparklingRoot, "package.json"), "{}");
    await fs.writeFile(source, "struct Host {}");
    const before = await createFingerprint({ platform: "ios" });
    expect(before.hash).not.toBe(withoutSparkling.hash);
    await fs.writeFile(source, "struct Host { let revision = 2 }");
    const after = await createFingerprint({ platform: "ios" });
    expect(after.hash).not.toBe(before.hash);
    expect(after.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath:
            "@hot-updater/lynx-sparkling/ios/Sources/HotUpdaterLynxSparkling/Host.swift",
        }),
      ]),
    );
  });

  it("fails when the application has no installed device SDK", async () => {
    await fs.unlink(path.join(cwd, "node_modules/@hot-updater/lynx"));
    await expect(createFingerprint({ platform: "ios" })).rejects.toThrow(
      "@hot-updater/lynx/package.json",
    );
  });

  it("includes integration-configured native sources", async () => {
    const source = path.join(cwd, "native-profile.txt");
    await fs.writeFile(source, "profile-a");
    const before = await createFingerprint({
      platform: "ios",
      extraSources: ["native-profile.txt"],
    });
    await fs.writeFile(source, "profile-b");
    const after = await createFingerprint({
      platform: "ios",
      extraSources: ["native-profile.txt"],
    });
    expect(after.hash).not.toBe(before.hash);
  });

  it("uses locale-independent Unicode source ordering", async () => {
    await Promise.all([
      fs.writeFile(path.join(cwd, "ios/Z.swift"), "upper"),
      fs.writeFile(path.join(cwd, "ios/ä.swift"), "non-ascii"),
    ]);

    const fingerprint = await createFingerprint({
      platform: "ios",
    });

    expect(
      fingerprint.sources.map((source) =>
        "filePath" in source ? source.filePath : source.id,
      ),
    ).toEqual([
      "@hot-updater/lynx/ios/Package.swift",
      "@hot-updater/lynx/ios/Sources/HotUpdaterLynxArtifact/Host.swift",
      "@hot-updater/lynx/package.json",
      "ios/Podfile.lock",
      "ios/Z.swift",
      "ios/ä.swift",
      "package.json",
    ]);
  });
});
