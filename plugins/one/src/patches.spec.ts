import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hotUpdaterPatches, type OneNativeAppPatch } from "./patches";
import { findHotUpdaterPatchesOptions } from "./tag";

// What `one prebuild` of One 2.15 generates, before and after the patches.
const fixture = (file: string, patched = false) =>
  readFileSync(
    path.join(
      import.meta.dirname,
      "__fixtures__/one-2.15",
      patched ? "patched" : "",
      file,
    ),
    "utf8",
  );

// Where each file lands in the generated ios/ or android/.
const PATHS = {
  "AppDelegate.swift": "OneBasic/AppDelegate.swift",
  "Info.plist": "OneBasic/Info.plist",
  "MainApplication.kt":
    "app/src/main/java/dev/onestack/starter/MainApplication.kt",
  "AndroidManifest.xml": "app/src/main/AndroidManifest.xml",
} as const;
const FILES = Object.keys(PATHS) as (keyof typeof PATHS)[];

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

/** The patch for `file`, applied as `one prebuild` applies it. */
const apply = (patches: OneNativeAppPatch[], file: string, content: string) => {
  const matches = patches.filter(
    (patch) => file === patch.file || file.endsWith(`/${patch.file}`),
  );
  expect(matches).toHaveLength(1);
  return matches[0]!.patch(content);
};

const projectWithKey = async (modulusLength = 2048) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "hot-updater-one-patches-"));
  tempDirs.push(cwd);
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  await writeFile(path.join(cwd, "public-key.pem"), publicKey);
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  return publicKey.trim();
};

describe("hotUpdaterPatches", () => {
  it("names each generated file One matches exactly once", () => {
    expect(
      hotUpdaterPatches().map(({ platform, file }) => [platform, file]),
    ).toEqual([
      ["ios", "AppDelegate.swift"],
      ["ios", "Info.plist"],
      ["android", "MainApplication.kt"],
      ["android", "main/AndroidManifest.xml"],
    ]);
  });

  it.each(FILES)("patches One's generated %s", (file) => {
    const patched = apply(
      hotUpdaterPatches({ channel: "production" }),
      PATHS[file],
      fixture(file),
    );
    expect(patched).toBe(fixture(file, true));
  });

  it.each(FILES)(
    "returns %s unchanged when its edit is there, as One checks",
    async (file) => {
      await projectWithKey();
      for (const options of [{}, { publicKeyPath: "public-key.pem" }]) {
        const patches = hotUpdaterPatches(options);
        const once = apply(patches, PATHS[file], fixture(file));
        expect(apply(patches, PATHS[file], once)).toBe(once);
      }
    },
  );

  it("defaults the channel to production and replaces a previous one", () => {
    const beta = apply(
      hotUpdaterPatches({ channel: "beta" }),
      PATHS["Info.plist"],
      fixture("Info.plist"),
    );
    const production = apply(hotUpdaterPatches(), PATHS["Info.plist"], beta);

    expect(production).toBe(fixture("Info.plist", true));
    expect(
      apply(
        hotUpdaterPatches(),
        PATHS["AndroidManifest.xml"],
        apply(
          hotUpdaterPatches({ channel: "beta" }),
          PATHS["AndroidManifest.xml"],
          fixture("AndroidManifest.xml"),
        ),
      ),
    ).toBe(fixture("AndroidManifest.xml", true));
  });

  it("writes the public key as the Expo config plugin does, and removes it without publicKeyPath", async () => {
    const publicKey = await projectWithKey();
    const patches = hotUpdaterPatches({ publicKeyPath: "public-key.pem" });

    const plist = apply(patches, PATHS["Info.plist"], fixture("Info.plist"));
    expect(plist).toContain(
      `<key>HOT_UPDATER_PUBLIC_KEY</key>\n\t<string>${publicKey}</string>`,
    );
    const manifest = apply(
      patches,
      PATHS["AndroidManifest.xml"],
      fixture("AndroidManifest.xml"),
    );
    expect(manifest).toContain(
      `<meta-data android:name="com.hotupdater.PUBLIC_KEY" android:value="${publicKey.replaceAll("\n", "\\n")}"/>`,
    );

    const withoutKey = hotUpdaterPatches();
    expect(apply(withoutKey, PATHS["Info.plist"], plist)).toBe(
      fixture("Info.plist", true),
    );
    expect(apply(withoutKey, PATHS["AndroidManifest.xml"], manifest)).toBe(
      fixture("AndroidManifest.xml", true),
    );
  });

  it("reads the key file only when prebuild patches, and rejects a weak key", async () => {
    await projectWithKey(1024);
    const patches = hotUpdaterPatches({ publicKeyPath: "public-key.pem" });

    expect(() =>
      apply(patches, PATHS["Info.plist"], fixture("Info.plist")),
    ).toThrow(
      "public-key.pem must be an RSA SPKI PEM public key of at least 2048 bits.",
    );
    expect(() =>
      apply(
        hotUpdaterPatches({ publicKeyPath: "missing.pem" }),
        PATHS["Info.plist"],
        fixture("Info.plist"),
      ),
    ).toThrow("cannot read the bundle signing public key file missing.pem");
  });

  it("rejects an empty publicKeyPath", () => {
    expect(() => hotUpdaterPatches({ publicKeyPath: " " })).toThrow(
      "publicKeyPath must be a non-empty path.",
    );
  });

  it.each([
    [
      "AppDelegate.swift",
      fixture("AppDelegate.swift").replace(
        'Bundle.main.url(forResource: "main", withExtension: "jsbundle")',
        "OneUpdates.bundleURL()",
      ),
    ],
    [
      "MainApplication.kt",
      fixture("MainApplication.kt").replace(
        "getDefaultReactHost(",
        "createHost(",
      ),
    ],
    ["Info.plist", "<plist></plist>"],
    ["AndroidManifest.xml", "<manifest></manifest>"],
  ])("throws when %s lacks its anchor, so prebuild stops", (file, content) => {
    expect(() =>
      apply(hotUpdaterPatches(), `app/src/main/${file}`, content),
    ).toThrow(`[hot-updater] cannot patch ${file}`);
  });

  it("tags its patches with the options the build adapter reads", () => {
    const options = { channel: "beta", publicKeyPath: "keys/public.pem" };
    const own = { platform: "ios", file: "Podfile", patch: (c: string) => c };

    expect(
      findHotUpdaterPatchesOptions([own, ...hotUpdaterPatches(options)]),
    ).toEqual(options);
    expect(findHotUpdaterPatchesOptions([own])).toBeUndefined();
    expect(findHotUpdaterPatchesOptions(undefined)).toBeUndefined();
  });
});
