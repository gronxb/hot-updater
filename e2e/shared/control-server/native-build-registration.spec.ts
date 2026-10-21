import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { StoragePutInput } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryCore } from "../memory-core.ts";
import {
  assertDependenciesInCheckout,
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

/**
 * An APK as the E2E build packs one, its code and its built-in bundle, or
 * an AAB, which keeps both under `base/`.
 */
const createApk = async (bundle: string, kind: "apk" | "aab" = "apk") => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hu-e2e-apk-"));
  roots.push(root);
  const base = kind === "aab" ? "base/" : "";
  const dex = `${base}${kind === "aab" ? "dex/" : ""}classes.dex`;
  const builtIn = `${base}assets/index.android.bundle`;
  await fs.mkdir(path.dirname(path.join(root, dex)), { recursive: true });
  await fs.writeFile(
    path.join(root, dex),
    `dex\n035\0${MIN_BUNDLE_ID}\0other strings`,
  );
  await fs.mkdir(path.dirname(path.join(root, builtIn)), { recursive: true });
  await fs.writeFile(path.join(root, builtIn), bundle);
  execFileSync("zip", ["-q", "-X", `app.${kind}`, dex, builtIn], {
    cwd: root,
  });
  return path.join(root, `app.${kind}`);
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
    await expect(
      readArtifactMinBundleId(await createApk("bundle", "aab"), "android"),
    ).resolves.toBe(MIN_BUNDLE_ID);
  });

  it("registers an AAB as an aab artifact", async () => {
    const { core } = createMemoryCore();
    await registerInstalledNativeBuild({
      core,
      storage: createStorage().storage,
      platform: "android",
      artifactPath: await createApk("bundle", "aab"),
      appVersion: "1.0",
    });

    await expect(
      core.findNativeBuild({
        platform: "android",
        channel: nativeBuildChannel(MIN_BUNDLE_ID),
        fingerprintHash: null,
        appVersion: "1.0",
      }),
    ).resolves.toMatchObject({ artifact_kind: "aab" });
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

describe("the checkout an OTA is built in", () => {
  /** A pnpm checkout: an app whose react-native links into the root store. */
  const createCheckout = async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "hu-e2e-checkout-"));
    roots.push(parent);
    const checkout = path.join(parent, "repo");
    const store = path.join(
      checkout,
      "node_modules/.pnpm/react-native@0.85.0/node_modules/react-native",
    );
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, "package.json"), "{}");
    await fs.mkdir(path.join(checkout, "app/node_modules"), {
      recursive: true,
    });
    await fs.symlink(
      "../../node_modules/.pnpm/react-native@0.85.0/node_modules/react-native",
      path.join(checkout, "app/node_modules/react-native"),
    );
    return checkout;
  };

  it("accepts another checkout of the app that installed its own dependencies", async () => {
    const built = await createCheckout();
    const deployedParent = await fs.mkdtemp(
      path.join(os.tmpdir(), "hu-e2e-other-checkout-"),
    );
    roots.push(deployedParent);
    // The same tree at another path, as another CI job checks it out.
    const deployed = path.join(deployedParent, "elsewhere");
    execFileSync("cp", ["-R", built, deployed]);

    for (const checkout of [built, deployed]) {
      await expect(
        assertDependenciesInCheckout({
          checkoutDir: checkout,
          projectDir: path.join(checkout, "app"),
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("refuses a checkout whose dependencies live in another one", async () => {
    const built = await createCheckout();
    const deployed = await createCheckout();
    // node_modules shared from the checkout that built the native app.
    await fs.rm(path.join(deployed, "node_modules"), {
      recursive: true,
      force: true,
    });
    await fs.symlink(
      path.join(built, "node_modules"),
      path.join(deployed, "node_modules"),
    );

    const dependency = await fs.realpath(
      path.join(
        built,
        "node_modules/.pnpm/react-native@0.85.0/node_modules/react-native",
      ),
    );
    const checkout = await fs.realpath(deployed);
    await expect(
      assertDependenciesInCheckout({
        checkoutDir: deployed,
        projectDir: path.join(deployed, "app"),
      }),
    ).rejects.toThrow(
      `resolves react-native to ${dependency}, outside the checkout ${checkout}`,
    );
  });
});
