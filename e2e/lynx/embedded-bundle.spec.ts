import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LYNX_E2E_BUILTIN_BUNDLE_ID,
  LYNX_E2E_SDK3_FILES,
  compileLynxE2eEmbedded,
  lynxE2eRuntimeId,
  materializeLynxNativeEmbedded,
  packageLynxEmbeddedDirectory,
  validateLynxEmbeddedDirectory,
} from "./embedded-bundle.ts";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function writeSdk3Fixture(root: string, prefix: string) {
  for (const name of LYNX_E2E_SDK3_FILES) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), `${prefix}-${name}`);
  }
}

async function collectFileHashes(root: string) {
  const hashes: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const name = path.relative(root, absolute).split(path.sep).join("/");
        hashes[name] = createHash("sha256")
          .update(await fs.readFile(absolute))
          .digest("hex");
      }
    }
  };
  await walk(root);
  return hashes;
}

describe("Lynx E2E embedded bundle packaging", () => {
  it("finalizes every E2E OTA archive with the exact sdk3 startup files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-e2e-ota-"));
    try {
      await fs.writeFile(path.join(root, "main.lynx.bundle"), "bundle-bytes");
      const { finishLynxE2eBundle } =
        await import("../../examples/lynx/scripts/e2e-assets.mjs");
      await finishLynxE2eBundle(root);

      expect(Object.keys(await collectFileHashes(root)).sort()).toEqual(
        [...LYNX_E2E_SDK3_FILES].sort(),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("writes a native-verifiable manifest for the builtin tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-e2e-embed-"));
    try {
      await fs.writeFile(path.join(root, "main.lynx.bundle"), "bundle-bytes");
      const result = await packageLynxEmbeddedDirectory({
        root,
        platform: "ios",
        bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
        runtimeId: "test-runtime",
      });
      const manifest = JSON.parse(
        await fs.readFile(path.join(root, "manifest.json"), "utf8"),
      ) as {
        bundleId: string;
        assets: Record<string, { fileHash: string }>;
      };
      const metadata = JSON.parse(
        await fs.readFile(path.join(root, "hot-updater-lynx.json"), "utf8"),
      ) as { bundleId: string; entry: string; platform: string };
      const bundleHash = createHash("sha256")
        .update("bundle-bytes")
        .digest("hex");
      expect(manifest.bundleId).toBe(LYNX_E2E_BUILTIN_BUNDLE_ID);
      expect(manifest.assets["main.lynx.bundle"]?.fileHash).toBe(bundleHash);
      expect(manifest.assets["hot-updater-lynx.json"]).toBeDefined();
      expect(manifest.assets["manifest.json"]).toBeUndefined();
      expect(metadata).toMatchObject({
        bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
        entry: "main.lynx.bundle",
        platform: "ios",
      });
      expect(result.manifestDigest).toBe(
        createHash("sha256")
          .update(await fs.readFile(path.join(root, "manifest.json")))
          .digest("hex"),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("materializes clean iOS and Android native build inputs", async () => {
    const exampleDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "lynx-native-embed-example-"),
    );
    try {
      for (const platform of ["ios", "android"] as const) {
        const source = path.join(exampleDir, `source-${platform}`);
        await fs.mkdir(source, { recursive: true });
        await writeSdk3Fixture(source, platform);
        const packaged = await packageLynxEmbeddedDirectory({
          root: source,
          platform,
          bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
          runtimeId: lynxE2eRuntimeId(platform),
        });
        const generated = await materializeLynxNativeEmbedded({
          exampleDir,
          platform,
          source,
        });
        await expect(
          Promise.all(generated.map((file) => fs.stat(file))),
        ).resolves.toHaveLength(generated.length);
        const nativeRoot =
          platform === "ios"
            ? path.join(exampleDir, "ios/Embedded/Public/react")
            : path.join(
                exampleDir,
                "android/.hot-updater/embedded/ota/react/A",
              );
        await expect(
          validateLynxEmbeddedDirectory({
            root: nativeRoot,
            platform,
            expectedBundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
            expectedRuntimeId: lynxE2eRuntimeId(platform),
            expectedFiles: LYNX_E2E_SDK3_FILES,
          }),
        ).resolves.toMatchObject({ entry: "main.lynx.bundle" });
        if (platform === "ios") {
          const descriptor = JSON.parse(
            await fs.readFile(
              path.join(exampleDir, "ios/Embedded/Public/react-native.json"),
              "utf8",
            ),
          ) as { bundleId: string; manifestDigest: string; runtimeId: string };
          expect(descriptor).toMatchObject({
            bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
            manifestDigest: packaged.manifestDigest,
            runtimeId: lynxE2eRuntimeId("ios"),
          });
        }
      }
    } finally {
      await fs.rm(exampleDir, { recursive: true, force: true });
    }
  });

  it("keeps scaffold fixture selection narrow and matrix selection authoritative", async () => {
    const [builder, scaffoldGradle, matrixGradle] = await Promise.all([
      fs.readFile(
        path.join(repo, "examples/lynx/scripts/build-e2e-native.mjs"),
        "utf8",
      ),
      fs.readFile(
        path.join(repo, "examples/lynx/android/app/build.gradle.kts"),
        "utf8",
      ),
      fs.readFile(
        path.join(repo, "examples/lynx/android/matrix-app/build.gradle.kts"),
        "utf8",
      ),
    ]);
    expect(builder).toContain("-PhotUpdaterLynxEmbeddedFrameworks=react");
    expect(scaffoldGradle).toContain(
      'providers.gradleProperty("hotUpdaterLynxEmbeddedFrameworks")',
    );
    expect(matrixGradle).toContain('listOf("react", "vue", "octane")');
    expect(matrixGradle).not.toContain("hotUpdaterLynxEmbeddedFrameworks");
  });

  it("materializes all three matrix frameworks without dropping earlier descriptors", async () => {
    const exampleDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "lynx-matrix-embed-example-"),
    );
    try {
      for (const [index, framework] of ["react", "vue", "octane"].entries()) {
        const source = path.join(exampleDir, `source-${framework}`);
        await fs.mkdir(source, { recursive: true });
        await writeSdk3Fixture(source, framework);
        await packageLynxEmbeddedDirectory({
          root: source,
          platform: "ios",
          bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
          runtimeId: lynxE2eRuntimeId("ios"),
        });
        await materializeLynxNativeEmbedded({
          exampleDir,
          platform: "ios",
          source,
          framework: framework as "react" | "vue" | "octane",
          resetPlatformRoot: index === 0,
        });
      }
      for (const framework of ["react", "vue", "octane"]) {
        await expect(
          fs.stat(
            path.join(
              exampleDir,
              `ios/Embedded/Public/${framework}-native.json`,
            ),
          ),
        ).resolves.toBeDefined();
      }
    } finally {
      await fs.rm(exampleDir, { recursive: true, force: true });
    }
  });

  it("keeps compiled React/Vue and finalized Octane A/B/C outputs endpoint-independent", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "lynx-endpoint-independent-"),
    );
    const originalAppBaseURL = process.env.HOT_UPDATER_E2E_APP_BASE_URL;
    const originalRuntimeConfigURL =
      process.env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL;
    try {
      const outputs = [];
      for (const [index, name] of ["first", "second"].entries()) {
        outputs.push(
          await compileLynxE2eEmbedded({
            exampleDir: path.join(repo, "examples/lynx"),
            platform: "ios",
            outDir: path.join(root, name),
            env: {
              ...process.env,
              HOT_UPDATER_E2E_APP_BASE_URL: `http://127.0.0.1:${3007 + index}/hot-updater`,
              HOT_UPDATER_E2E_RUNTIME_CONFIG_URL: `http://127.0.0.1:${3107 + index}/e2e/runtime-config`,
            },
          }),
        );
      }
      for (const name of [
        ...LYNX_E2E_SDK3_FILES,
        "hot-updater-lynx.json",
        "manifest.json",
      ]) {
        const [first, second] = await Promise.all(
          outputs.map((output) => fs.readFile(path.join(output, name))),
        );
        expect(first.equals(second), name).toBe(true);
      }

      const [{ buildPublic }, { finishSpike }] = await Promise.all([
        import("../../examples/lynx/scripts/build-public.mjs"),
        import("../../examples/lynx/scripts/spike-assets.mjs"),
      ]);
      const frameworkVariants = new Map<string, Record<string, string>>();
      for (const framework of ["react", "vue", "octane"] as const) {
        for (const variant of ["A", "B", "C"] as const) {
          const endpointHashes = [];
          for (const [index, endpoint] of ["first", "second"].entries()) {
            process.env.HOT_UPDATER_E2E_APP_BASE_URL = `http://127.0.0.1:${3207 + index}/hot-updater`;
            process.env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL = `http://127.0.0.1:${3307 + index}/e2e/runtime-config`;
            const outDir = path.join(
              root,
              `${framework}-${variant}-${endpoint}`,
            );
            if (framework !== "octane") {
              await buildPublic({
                framework,
                outDir,
                variant,
              });
            } else {
              // The pinned Octane compiler is intentionally external. This
              // offline path still exercises the shared output finalizer used
              // by build-octane.mjs instead of reducing the check to source text.
              await fs.mkdir(outDir, { recursive: true });
              await fs.writeFile(
                path.join(outDir, "main.lynx.bundle"),
                `octane-compiler-output-${variant}`,
              );
              await finishSpike(outDir, framework, variant, {
                repository: "https://github.com/octanejs/octane",
                commit: "c31f629185f7d768c821557f6fb49dc46daf671c",
                rspeedy: "0.16.0",
                behavior: "normal",
                resourceSet: "sdk3",
                assetPrefix: "hot-updater:///",
              });
            }
            endpointHashes.push(await collectFileHashes(outDir));
          }
          expect(endpointHashes[1], `${framework}/${variant}`).toEqual(
            endpointHashes[0],
          );
          expect(
            Object.keys(endpointHashes[0]!).sort(),
            `${framework}/${variant}`,
          ).toEqual([...LYNX_E2E_SDK3_FILES].sort());
          frameworkVariants.set(`${framework}/${variant}`, endpointHashes[0]!);
        }
        expect(
          new Set(
            ["A", "B", "C"].map(
              (variant) =>
                frameworkVariants.get(`${framework}/${variant}`)?.[
                  "main.lynx.bundle"
                ],
            ),
          ).size,
          framework,
        ).toBe(3);
      }
    } finally {
      if (originalAppBaseURL === undefined) {
        delete process.env.HOT_UPDATER_E2E_APP_BASE_URL;
      } else {
        process.env.HOT_UPDATER_E2E_APP_BASE_URL = originalAppBaseURL;
      }
      if (originalRuntimeConfigURL === undefined) {
        delete process.env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL;
      } else {
        process.env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL =
          originalRuntimeConfigURL;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects a stale generated tree whose payload no longer matches its manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-e2e-stale-"));
    try {
      await fs.writeFile(path.join(root, "main.lynx.bundle"), "original");
      await packageLynxEmbeddedDirectory({
        root,
        platform: "ios",
        bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
        runtimeId: lynxE2eRuntimeId("ios"),
      });
      await fs.writeFile(path.join(root, "main.lynx.bundle"), "stale");

      await expect(
        validateLynxEmbeddedDirectory({
          root,
          platform: "ios",
          expectedBundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
          expectedRuntimeId: lynxE2eRuntimeId("ios"),
        }),
      ).rejects.toThrow(
        "Generated Lynx embedded hash mismatch: main.lynx.bundle",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not relabel a main-only tree as the sdk1 resource set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-sdk1-missing-"));
    const exampleDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "lynx-sdk1-example-"),
    );
    try {
      await fs.writeFile(path.join(root, "main.lynx.bundle"), "sdk1");
      await packageLynxEmbeddedDirectory({
        root,
        platform: "ios",
        bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
        runtimeId: lynxE2eRuntimeId("ios"),
      });
      await expect(
        materializeLynxNativeEmbedded({
          exampleDir,
          platform: "ios",
          source: root,
          variant: "sdk1",
        }),
      ).rejects.toThrow(
        "Generated Lynx embedded resource is missing: assets/probe.png",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(exampleDir, { recursive: true, force: true });
    }
  });
});
