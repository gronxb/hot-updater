import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ONE_NATIVE_SOURCES, one, readOneNativeApp } from "./one";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

/**
 * A project whose `one/vite` returns `native.app`, the way One's
 * `loadUserOneOptions` returns the app's vite config. `hotUpdater` is what
 * `hotUpdaterPatches` tags its patches with; `null` leaves them out.
 */
const createOneProject = async ({
  hotUpdater = null,
  version,
}: {
  hotUpdater?: Record<string, string> | null;
  version?: string;
} = {}) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "hot-updater-one-"));
  tempDirs.push(cwd);
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "app", dependencies: { one: "2.15.0" } }),
  );
  const oneDir = path.join(cwd, "node_modules", "one");
  await mkdir(oneDir, { recursive: true });
  await writeFile(
    path.join(oneDir, "package.json"),
    JSON.stringify({
      name: "one",
      exports: { "./vite": { require: "./vite.cjs" } },
    }),
  );
  const patch = (options: Record<string, string>) =>
    `Object.defineProperty({ platform: "ios", file: "AppDelegate.swift", patch: (content) => content }, Symbol.for("@hot-updater/one/patches"), { value: ${JSON.stringify(options)} })`;
  await writeFile(
    path.join(oneDir, "vite.cjs"),
    `exports.loadUserOneOptions = async () => ({
  oneOptions: {
    native: {
      app: {
        name: "App",
        ${version === undefined ? "" : `version: ${JSON.stringify(version)},`}
        patches: [
          { platform: "android", file: "MainApplication.kt", patch: (content) => content },
          ${hotUpdater === null ? "" : patch(hotUpdater)}
        ],
      },
    },
  },
});`,
  );
  return cwd;
};

describe("readOneNativeApp", () => {
  it("has no Hot Updater options when native.app.patches lacks hotUpdaterPatches", async () => {
    const cwd = await createOneProject();
    await expect(readOneNativeApp(cwd)).resolves.toEqual({});
  });

  it("reads the options hotUpdaterPatches tags its patches with", async () => {
    const cwd = await createOneProject({
      hotUpdater: { channel: "beta", publicKeyPath: "keys/public.pem" },
      version: "2.1.0",
    });
    await expect(readOneNativeApp(cwd)).resolves.toEqual({
      version: "2.1.0",
      hotUpdater: { channel: "beta", publicKeyPath: "keys/public.pem" },
    });
  });

  it("restores the working directory after reading the config", async () => {
    const cwd = await createOneProject({ hotUpdater: {} });
    const before = process.cwd();
    await readOneNativeApp(cwd);
    expect(process.cwd()).toBe(before);
  });
});

describe("one", () => {
  it("builds through bare and adds One's prebuild", async () => {
    const cwd = await createOneProject();
    const adapter = await one()({ cwd });

    expect(adapter.name).toBe("one");
    expect(adapter.nativeBuild?.fingerprint).toEqual(expect.any(Function));
    expect(adapter.nativeBuild?.prebuild).toEqual(expect.any(Function));
  });

  it("reads native files itself without hotUpdaterPatches", async () => {
    const cwd = await createOneProject();
    const adapter = await one()({ cwd });

    expect(adapter.nativeBuild).not.toHaveProperty("getBundleSigningPublicKey");
    expect(adapter.nativeBuild).not.toHaveProperty(
      "getFingerprintExtraSources",
    );
  });

  it("reads the signing key from hotUpdaterPatches' publicKeyPath", async () => {
    const cwd = await createOneProject({
      hotUpdater: { publicKeyPath: "keys/public.pem" },
    });
    const { publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    await mkdir(path.join(cwd, "keys"));
    await writeFile(path.join(cwd, "keys", "public.pem"), publicKey);

    const adapter = await one()({ cwd });

    await expect(
      adapter.nativeBuild?.getBundleSigningPublicKey?.(),
    ).resolves.toEqual({
      publicKey: expect.stringContaining("BEGIN PUBLIC KEY"),
    });
    await expect(
      adapter.nativeBuild?.getFingerprintExtraSources?.(),
    ).resolves.toEqual(["keys/public.pem"]);
  });

  it("has no signing key when hotUpdaterPatches sets no publicKeyPath", async () => {
    const cwd = await createOneProject({ hotUpdater: {} });
    const adapter = await one()({ cwd });

    await expect(
      adapter.nativeBuild?.getBundleSigningPublicKey?.(),
    ).resolves.toBeNull();
    await expect(
      adapter.nativeBuild?.getFingerprintExtraSources?.(),
    ).resolves.toEqual([]);
  });

  it("reports what one prebuild writes", async () => {
    const cwd = await createOneProject({
      hotUpdater: { channel: "beta", publicKeyPath: "keys/public.pem" },
      version: "2.1.0",
    });
    const adapter = await one()({ cwd });

    await expect(
      adapter.nativeBuild?.getNativeProjectValues?.({ platform: "ios" }),
    ).resolves.toEqual({
      appVersion: "2.1.0",
      channel: "beta",
      publicKeyPath: "keys/public.pem",
    });
  });

  it("reports the production channel, and no channel without hotUpdaterPatches", async () => {
    const withPatches = await one()({
      cwd: await createOneProject({ hotUpdater: {} }),
    });
    const without = await one()({ cwd: await createOneProject() });

    await expect(
      withPatches.nativeBuild?.getNativeProjectValues?.({ platform: "ios" }),
    ).resolves.toEqual({ channel: "production" });
    await expect(
      without.nativeBuild?.getNativeProjectValues?.({ platform: "ios" }),
    ).resolves.toEqual({});
  });
});

describe("ONE_NATIVE_SOURCES", () => {
  it("matches the app's Swift and Kotlin sources, not the generated projects", async () => {
    const { default: fg } = await import("fast-glob");
    const cwd = await mkdtemp(path.join(tmpdir(), "hot-updater-one-src-"));
    tempDirs.push(cwd);
    const files = [
      "native/Device.kt",
      "native/Showcase/Package.swift",
      "native/Showcase/Device.swift",
      "features/Camera.kt",
      "ios/App/AppDelegate.swift",
      "android/app/src/main/java/MainApplication.kt",
      "dist/Copied.swift",
      "node_modules/pkg/Lib.swift",
      "native/.cache/Old.swift",
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await writeFile(path.join(cwd, file), "");
    }
    const match = (platform: "ios" | "android") =>
      fg(ONE_NATIVE_SOURCES[platform], { cwd, dot: true }).then((found) =>
        found.sort(),
      );

    await expect(match("ios")).resolves.toEqual([
      "native/Showcase/Device.swift",
      "native/Showcase/Package.swift",
    ]);
    await expect(match("android")).resolves.toEqual([
      "features/Camera.kt",
      "native/Device.kt",
    ]);
  });
});
