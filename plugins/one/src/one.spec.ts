import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { one, readOnePluginProps } from "./one";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

/**
 * A project whose `one/vite` returns `plugins` as `native.app.plugins`, the
 * way One's `loadUserOneOptions` returns the app's vite config.
 */
const createOneProject = async (plugins?: unknown[]) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "hot-updater-one-"));
  tempDirs.push(cwd);
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "app", dependencies: { one: "2.8.1" } }),
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
  const app = plugins === undefined ? {} : { plugins };
  await writeFile(
    path.join(oneDir, "vite.cjs"),
    `exports.loadUserOneOptions = async () => ({
  oneOptions: { native: { app: ${JSON.stringify(app)} } },
});`,
  );
  return cwd;
};

describe("readOnePluginProps", () => {
  it("returns undefined when native.app.plugins does not list the plugin", async () => {
    const cwd = await createOneProject(["@react-native-firebase/app"]);
    await expect(readOnePluginProps(cwd)).resolves.toBeUndefined();
  });

  it("returns empty props for the plugin listed by name", async () => {
    const cwd = await createOneProject(["@hot-updater/one"]);
    await expect(readOnePluginProps(cwd)).resolves.toEqual({});
  });

  it("returns the props of the plugin listed with options", async () => {
    const cwd = await createOneProject([
      [
        "@hot-updater/one",
        { channel: "beta", publicKeyPath: "keys/public.pem" },
      ],
    ]);
    await expect(readOnePluginProps(cwd)).resolves.toEqual({
      channel: "beta",
      publicKeyPath: "keys/public.pem",
    });
  });

  it("restores the working directory after reading the config", async () => {
    const cwd = await createOneProject(["@hot-updater/one"]);
    const before = process.cwd();
    await readOnePluginProps(cwd);
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

  it("reads native files itself when the app does not list the plugin", async () => {
    const cwd = await createOneProject();
    const adapter = await one()({ cwd });

    expect(adapter.nativeBuild).not.toHaveProperty("getBundleSigningPublicKey");
    expect(adapter.nativeBuild).not.toHaveProperty(
      "getFingerprintExtraSources",
    );
  });

  it("reads the signing key from the plugin's publicKeyPath", async () => {
    const cwd = await createOneProject([
      ["@hot-updater/one", { publicKeyPath: "keys/public.pem" }],
    ]);
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

  it("has no signing key when the plugin sets no publicKeyPath", async () => {
    const cwd = await createOneProject(["@hot-updater/one"]);
    const adapter = await one()({ cwd });

    await expect(
      adapter.nativeBuild?.getBundleSigningPublicKey?.(),
    ).resolves.toBeNull();
    await expect(
      adapter.nativeBuild?.getFingerprintExtraSources?.(),
    ).resolves.toEqual([]);
  });

  it("rejects an empty publicKeyPath", async () => {
    const cwd = await createOneProject([
      ["@hot-updater/one", { publicKeyPath: " " }],
    ]);
    const adapter = await one()({ cwd });

    await expect(
      adapter.nativeBuild?.getBundleSigningPublicKey?.(),
    ).rejects.toThrow(
      "@hot-updater/one publicKeyPath must be a non-empty path.",
    );
  });
});
