import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertDependenciesInCheckout,
  nativeBuildChannel,
  parseNativeBuildImportOutput,
  readArtifactMinBundleId,
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

describe("the installed E2E app's native build", () => {
  it("reads the MIN_BUNDLE_ID the build compiled in, apart from the CLI", async () => {
    await expect(
      readArtifactMinBundleId(await createApk("bundle"), "android"),
    ).resolves.toBe(MIN_BUNDLE_ID);
    await expect(
      readArtifactMinBundleId(await createApk("bundle", "aab"), "android"),
    ).resolves.toBe(MIN_BUNDLE_ID);
  });

  it("names the channel a binary registers under by its build time", () => {
    expect(nativeBuildChannel(MIN_BUNDLE_ID)).toBe(
      "e2e-native-build-019a0b1c2d3e",
    );
  });

  it("reads the JSON line native-build import --json ends its output with", () => {
    const nativeBuild = {
      id: "019a0000-0000-7000-8000-00000000b001",
      min_bundle_id: MIN_BUNDLE_ID,
      channel_id: "channel:x",
      app_version: "1.0",
      artifact_kind: "app",
    };
    expect(
      parseNativeBuildImportOutput(
        [
          "│  Native build artifact",
          "◆  Registered native build 019a…",
          JSON.stringify({ ok: true, alreadyImported: true, nativeBuild }),
          "",
        ].join("\n"),
      ),
    ).toEqual({ ok: true, alreadyImported: true, nativeBuild });
    expect(() => parseNativeBuildImportOutput("■  failed\n")).toThrow(
      "printed no JSON",
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
