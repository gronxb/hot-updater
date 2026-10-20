import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { StoragePutInput } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryCore } from "../memory-core.ts";
import {
  nativeBuildChannel,
  readArtifactMinBundleId,
  registerInstalledNativeBuild,
} from "./native-build-registration.ts";

const MIN_BUNDLE_ID = "019a0b1c-2d3e-7000-8000-000000000000";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** An APK as the E2E build packs one: its code and its built-in bundle. */
const createApk = async (bundle: string, minBundleId = MIN_BUNDLE_ID) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hu-e2e-apk-"));
  roots.push(root);
  await fs.writeFile(
    path.join(root, "classes.dex"),
    `dex\n035\0${minBundleId}\0other strings`,
  );
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(path.join(root, "assets/index.android.bundle"), bundle);
  execFileSync(
    "zip",
    ["-q", "-X", "app.apk", "classes.dex", "assets/index.android.bundle"],
    {
      cwd: root,
    },
  );
  return path.join(root, "app.apk");
};

const createStorage = () => {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    storage: {
      name: "memory",
      protocol: "memory",
      put: async ({ key, body }: StoragePutInput) => {
        objects.set(
          key,
          new Uint8Array(await new Response(body).arrayBuffer()),
        );
        return { storageUri: `memory://bucket/${key}` };
      },
    },
  };
};

describe("registering the installed E2E app as a native build", () => {
  it("reads the MIN_BUNDLE_ID the build compiled in", async () => {
    await expect(
      readArtifactMinBundleId(await createApk("bundle"), "android"),
    ).resolves.toBe(MIN_BUNDLE_ID);
  });

  it("registers a binary once, under its own channel, and checks it after", async () => {
    const { core } = createMemoryCore();
    const { objects, storage } = createStorage();
    const artifactPath = await createApk("built-in bundle bytes");
    const register = () =>
      registerInstalledNativeBuild({
        core,
        storage,
        platform: "android",
        artifactPath,
        appVersion: "1.0",
      });

    await expect(register()).resolves.toMatchObject({
      minBundleId: MIN_BUNDLE_ID,
      channel: nativeBuildChannel(MIN_BUNDLE_ID),
      registered: true,
    });
    const nativeBuild = await core.findNativeBuild({
      platform: "android",
      channel: nativeBuildChannel(MIN_BUNDLE_ID),
      fingerprintHash: null,
      appVersion: "1.0",
    });
    expect(nativeBuild).toMatchObject({
      min_bundle_id: MIN_BUNDLE_ID,
      artifact_kind: "apk",
    });
    // The built-in bundle as deploy stores a bundle, and the artifact.
    expect([...objects.keys()].sort()).toEqual([
      expect.stringMatching(/^assets\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.br$/),
      `bundles/${MIN_BUNDLE_ID}/manifest.json`,
      `native-builds/android/${nativeBuild!.id}/app.apk`,
    ]);

    // Another run of the same binary finds it registered.
    await expect(register()).resolves.toMatchObject({ registered: false });
    expect(objects.size).toBe(3);
  });

  it("refuses an ID registered with other bytes", async () => {
    const { core } = createMemoryCore();
    const { storage } = createStorage();
    const register = async (bundle: string) =>
      registerInstalledNativeBuild({
        core,
        storage,
        platform: "android",
        artifactPath: await createApk(bundle),
        appVersion: "1.0",
      });

    await register("first bytes");
    await expect(register("other bytes")).rejects.toThrow(
      `Built-in bundle ${MIN_BUNDLE_ID} is registered with other bytes`,
    );
  });
});
