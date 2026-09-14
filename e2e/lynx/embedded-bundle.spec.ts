import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LYNX_E2E_BUILTIN_BUNDLE_ID,
  LYNX_E2E_PAGE_ENTRIES,
  LYNX_E2E_PAGE_ESSENTIAL_RESOURCES,
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

function compilerPageGraph(threadSuffix = "__main-thread") {
  const assets = [
    ["assets/bootstrap.js", "bootstrap"],
    ["assets/probe.png", "probe"],
    ["assets/probe.ttf", "font"],
    ["dynamic/component.lynx.bundle", "dynamic"],
  ] as const;
  const fontModule = "spike/compiler-page-resources/font.page-resource";
  const nodes = [
    ...["detail.lynx.bundle", "main.lynx.bundle"].map((entry) => ({
      id: `page:${entry}`,
      kind: "page",
      path: entry,
    })),
    ...["detail", `detail${threadSuffix}`, "main", `main${threadSuffix}`].map(
      (name) => ({ id: `entry:${name}`, kind: "entry", name }),
    ),
    ...["detail", `detail${threadSuffix}`, "main", `main${threadSuffix}`].map(
      (name) => ({ id: `chunk:${name}`, kind: "chunk", name }),
    ),
    ...assets.flatMap(([asset, source]) => {
      const module = `spike/compiler-page-resources/${source}.page-resource`;
      return [
        { id: `module:${module}`, kind: "module", name: module },
        {
          id: `asset:${asset}`,
          kind: "asset",
          path: asset,
          source: module,
          essential: true,
        },
      ];
    }),
    {
      id: "asset:assets/OFL.txt",
      kind: "asset",
      path: "assets/OFL.txt",
      source: fontModule,
      essential: false,
    },
  ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const edges = [
    ...["detail", `detail${threadSuffix}`].flatMap((entry) => [
      { from: "page:detail.lynx.bundle", kind: "compiledBy", to: `entry:${entry}` },
      { from: `entry:${entry}`, kind: "contains", to: `chunk:${entry}` },
    ]),
    ...["main", `main${threadSuffix}`].flatMap((entry) => [
      { from: "page:main.lynx.bundle", kind: "compiledBy", to: `entry:${entry}` },
      { from: `entry:${entry}`, kind: "contains", to: `chunk:${entry}` },
    ]),
    ...assets.flatMap(([asset, source]) => {
      const module = `module:spike/compiler-page-resources/${source}.page-resource`;
      return [
        { from: "chunk:main", kind: "contains", to: module },
        { from: module, kind: "emits", to: `asset:${asset}` },
        { from: "page:main.lynx.bundle", kind: "requires", to: `asset:${asset}` },
      ];
    }),
    {
      from: `module:${fontModule}`,
      kind: "emits",
      to: "asset:assets/OFL.txt",
    },
  ].sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return {
    schemaVersion: 1,
    source: "@rspack/core:chunkGraph",
    compilerVersion: "1.7.11",
    entries: [
      {
        entry: "detail.lynx.bundle",
        compilerEntries: ["detail", `detail${threadSuffix}`].sort(),
        resources: ["detail.lynx.bundle"],
      },
      {
        entry: "main.lynx.bundle",
        compilerEntries: ["main", `main${threadSuffix}`].sort(),
        resources: [
          "assets/bootstrap.js",
          "assets/probe.png",
          "assets/probe.ttf",
          "dynamic/component.lynx.bundle",
          "main.lynx.bundle",
        ],
      },
    ],
    auxiliaryAssets: ["assets/OFL.txt"],
    edges,
    nodes,
  };
}

describe("Lynx E2E embedded bundle packaging", () => {
  it("finalizes every E2E OTA archive with the exact sdk3 startup files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-e2e-ota-"));
    try {
      await fs.writeFile(path.join(root, "detail.lynx.bundle"), "detail-bytes");
      await fs.writeFile(
        path.join(root, "main.lynx.bundle"),
        [
          "assets/bootstrap.js",
          "assets/probe.png",
          "assets/probe.ttf",
          "dynamic/component.lynx.bundle",
        ].join("\n"),
      );
      for (const name of LYNX_E2E_SDK3_FILES.filter(
        (name) => name !== "main.lynx.bundle" && name !== "detail.lynx.bundle",
      )) {
        await fs.mkdir(path.dirname(path.join(root, name)), {
          recursive: true,
        });
        await fs.writeFile(path.join(root, name), `compiler-${name}`);
      }
      await fs.writeFile(
        `${root}.page-graph.json`,
        JSON.stringify(compilerPageGraph()),
      );
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
      await fs.writeFile(path.join(root, "detail.lynx.bundle"), "detail-bytes");
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
      ) as {
        bundleId: string;
        entry: string;
        pageEntries: string[];
        pageEssentialResources: {
          entry: string;
          resources: string[];
        }[];
        platform: string;
      };
      const bundleHash = createHash("sha256")
        .update("bundle-bytes")
        .digest("hex");
      expect(manifest.bundleId).toBe(LYNX_E2E_BUILTIN_BUNDLE_ID);
      expect(manifest.assets["main.lynx.bundle"]?.fileHash).toBe(bundleHash);
      expect(manifest.assets["detail.lynx.bundle"]?.fileHash).toBe(
        createHash("sha256").update("detail-bytes").digest("hex"),
      );
      expect(manifest.assets["hot-updater-lynx.json"]).toBeDefined();
      expect(manifest.assets["manifest.json"]).toBeUndefined();
      expect(metadata).toMatchObject({
        bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
        entry: "main.lynx.bundle",
        pageEntries: LYNX_E2E_PAGE_ENTRIES,
        pageEssentialResources: LYNX_E2E_PAGE_ESSENTIAL_RESOURCES,
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
        ).resolves.toMatchObject({
          entry: "main.lynx.bundle",
          pageEntries: LYNX_E2E_PAGE_ENTRIES,
          pageEssentialResources: LYNX_E2E_PAGE_ESSENTIAL_RESOURCES,
        });
        if (platform === "ios") {
          const descriptor = JSON.parse(
            await fs.readFile(
              path.join(exampleDir, "ios/Embedded/Public/react-native.json"),
              "utf8",
            ),
          ) as {
            bundleId: string;
            manifestDigest: string;
            pageEntries: string[];
            pageEssentialResources: {
              entry: string;
              resources: string[];
            }[];
            runtimeId: string;
          };
          expect(descriptor).toMatchObject({
            bundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
            manifestDigest: packaged.manifestDigest,
            pageEntries: LYNX_E2E_PAGE_ENTRIES,
            pageEssentialResources: LYNX_E2E_PAGE_ESSENTIAL_RESOURCES,
            runtimeId: lynxE2eRuntimeId("ios"),
          });
        }
      }
    } finally {
      await fs.rm(exampleDir, { recursive: true, force: true });
    }
  });

  it("keeps scaffold fixture selection narrow and matrix selection authoritative", async () => {
    const [
      builder,
      scaffoldActivity,
      scaffoldGradle,
      matrixActivity,
      matrixGradle,
      iosScaffoldHost,
      iosScaffoldApp,
      iosMatrixHarness,
      iosProject,
    ] = await Promise.all([
      fs.readFile(
        path.join(repo, "examples/lynx/scripts/build-e2e-native.mjs"),
        "utf8",
      ),
      fs.readFile(
        path.join(
          repo,
          "examples/lynx/android/app/src/main/java/com/hotupdater/lynxexample/OtaActivity.kt",
        ),
        "utf8",
      ),
      fs.readFile(
        path.join(repo, "examples/lynx/android/e2e-app/build.gradle.kts"),
        "utf8",
      ),
      fs.readFile(
        path.join(
          repo,
          "examples/lynx/android/matrix-app/src/main/java/com/hotupdater/lynxmatrix/MatrixActivity.kt",
        ),
        "utf8",
      ),
      fs.readFile(
        path.join(repo, "examples/lynx/android/matrix-app/build.gradle.kts"),
        "utf8",
      ),
      fs.readFile(
        path.join(
          repo,
          "examples/lynx/ios/SparklingGo/SparklingGo/PublicHost.swift",
        ),
        "utf8",
      ),
      fs.readFile(
        path.join(
          repo,
          "examples/lynx/ios/SparklingGo/SparklingGo/SparklingGoApp.swift",
        ),
        "utf8",
      ),
      fs.readFile(
        path.join(
          repo,
          "examples/lynx/ios/MatrixHarness/MatrixHarnessApp.swift",
        ),
        "utf8",
      ),
      fs.readFile(
        path.join(
          repo,
          "examples/lynx/ios/SparklingGo.xcodeproj/project.pbxproj",
        ),
        "utf8",
      ),
    ]);
    expect(builder).not.toContain("hotUpdaterLynxEmbeddedFrameworks");
    expect(scaffoldGradle).toContain(
      'file("../.hot-updater/embedded/ota/react/A/manifest.json")',
    );
    expect(scaffoldGradle).not.toContain("hotUpdaterLynxEmbeddedFrameworks");
    for (const selector of ["framework", "embeddedDir"]) {
      expect(scaffoldActivity).not.toContain(`getStringExtra("${selector}")`);
      expect(matrixActivity).toContain(`getStringExtra("${selector}")`);
    }
    expect(matrixGradle).toContain('listOf("react", "vue", "octane")');
    expect(matrixGradle).not.toContain("hotUpdaterLynxEmbeddedFrameworks");
    for (const selector of [
      "--ota-framework=",
      "--ota-channel=",
      "--ota-embedded-dir=",
    ]) {
      expect(iosScaffoldHost).not.toContain(selector);
      expect(iosScaffoldApp).not.toContain(selector);
      expect(iosMatrixHarness).toContain(selector);
    }
    expect(iosProject).not.toContain("PublicHost.swift in Sources");
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
    await fs.mkdir(path.join(repo, "examples/lynx/.hot-updater"), {
      recursive: true,
    });
    const publicBuildRoot = await fs.mkdtemp(
      path.join(repo, "examples/lynx/.hot-updater/endpoint-independent-"),
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

      const { buildPublic } = await import(
        "../../examples/lynx/scripts/build-public.mjs"
      );
      const frameworkVariants = new Map<string, Record<string, string>>();
      for (const framework of ["react", "vue", "octane"] as const) {
        for (const variant of ["A", "B", "C"] as const) {
          const endpointHashes = [];
          for (const [index, endpoint] of ["first", "second"].entries()) {
            process.env.HOT_UPDATER_E2E_APP_BASE_URL = `http://127.0.0.1:${3207 + index}/hot-updater`;
            process.env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL = `http://127.0.0.1:${3307 + index}/e2e/runtime-config`;
            const outDir = path.join(
              publicBuildRoot,
              `${framework}-${variant}-${endpoint}`,
            );
            await buildPublic({
              framework,
              outDir,
              variant,
            });
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
        expect(
          new Set(
            ["A", "B", "C"].map(
              (variant) =>
                frameworkVariants.get(`${framework}/${variant}`)?.[
                  "detail.lynx.bundle"
                ],
            ),
          ).size,
          `${framework} detail`,
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
      await fs.rm(publicBuildRoot, { recursive: true, force: true });
    }
  }, 300_000);

  it("rejects a stale generated tree whose payload no longer matches its manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-e2e-stale-"));
    try {
      await writeSdk3Fixture(root, "original");
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
      await fs.writeFile(path.join(root, "detail.lynx.bundle"), "detail");
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
