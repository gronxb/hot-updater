import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const exampleRoot = path.resolve(import.meta.dirname, "../../../examples/lynx");
const e2eBuildRuntimeIdPath = path.join(
  exampleRoot,
  "src/e2eBuildRuntimeId.ts",
);
const { lynxHostRuntimeId, resolveE2eBuildRuntimeId } = await import(
  e2eBuildRuntimeIdPath
);
const testRoot = path.join(
  exampleRoot,
  ".hot-updater",
  `build-regression-${process.pid}`,
);
const spikeAssetsPath = path.join(exampleRoot, "scripts/spike-assets.mjs");
const buildPublicPath = path.join(exampleRoot, "scripts/build-public.mjs");
const nativeBuilderPath = path.join(
  exampleRoot,
  "scripts/build-e2e-native.mjs",
);
const productionEmbeddedContractPath = path.join(
  exampleRoot,
  "scripts/production-embedded-contract.mjs",
);
const productionConfigurationPath = path.join(
  exampleRoot,
  "scripts/production-configuration.mjs",
);
const productionSdkPath = path.join(exampleRoot, "spike/production-sdk.ts");
const { resolveProductionAppBaseURL } = await import(
  productionConfigurationPath
);

const productionMainSdkCalls = [
  ".getLaunchConfiguration()",
  ".init({baseURL:",
  ".checkForUpdate({updateStrategy:",
  ".updateBundle()",
  ".notifyAppReady()",
  ".reload()",
];
const productionMainFixture = [
  "sparkling-navigation router.open detail.lynx.bundle Open detail page",
  ...productionMainSdkCalls,
].join(" ");
const productionDetailFixture =
  "sparkling-navigation router.close Close detail page .notifyAppReady()";

interface CompilerOutputOptions {
  readonly output: string;
  readonly main?: string;
  readonly extraFiles?: readonly (readonly [string, string])[];
  readonly includeGraph?: boolean;
}

afterEach(() => fs.rm(testRoot, { recursive: true, force: true }));

const writeCompilerOutput = async ({
  output,
  main = "main",
  extraFiles = [],
  includeGraph = true,
}: CompilerOutputOptions) => {
  await fs.mkdir(path.join(output, "assets"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(output, "detail.lynx.bundle"), "detail"),
    fs.writeFile(path.join(output, "main.lynx.bundle"), main),
    fs.writeFile(path.join(output, "assets/probe.png"), "probe"),
    ...extraFiles.map(([file, contents]) =>
      fs.writeFile(path.join(output, file), contents),
    ),
  ]);
  if (includeGraph) {
    await fs.writeFile(
      `${output}.page-graph.json`,
      JSON.stringify({
        auxiliaryAssets: [],
        compilerVersion: "1.7.11",
        edges: [
          {
            from: "chunk:main",
            kind: "contains",
            to: "module:spike/compiler-page-resources/probe.page-resource",
          },
          { from: "entry:detail", kind: "contains", to: "chunk:detail" },
          { from: "entry:main", kind: "contains", to: "chunk:main" },
          {
            from: "module:spike/compiler-page-resources/probe.page-resource",
            kind: "emits",
            to: "asset:assets/probe.png",
          },
          {
            from: "page:detail.lynx.bundle",
            kind: "compiledBy",
            to: "entry:detail",
          },
          {
            from: "page:main.lynx.bundle",
            kind: "compiledBy",
            to: "entry:main",
          },
          {
            from: "page:main.lynx.bundle",
            kind: "requires",
            to: "asset:assets/probe.png",
          },
        ].sort((left, right) => {
          const leftValue = JSON.stringify(left);
          const rightValue = JSON.stringify(right);
          return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
        }),
        entries: [
          {
            entry: "detail.lynx.bundle",
            compilerEntries: ["detail", "detail__main-thread"],
            resources: ["detail.lynx.bundle"],
          },
          {
            entry: "main.lynx.bundle",
            compilerEntries: ["main", "main__main-thread"],
            resources: ["assets/probe.png", "main.lynx.bundle"],
          },
        ],
        nodes: [
          {
            essential: true,
            id: "asset:assets/probe.png",
            kind: "asset",
            path: "assets/probe.png",
            source: "spike/compiler-page-resources/probe.page-resource",
          },
          { id: "chunk:detail", kind: "chunk", name: "detail" },
          { id: "chunk:main", kind: "chunk", name: "main" },
          { id: "entry:detail", kind: "entry", name: "detail" },
          { id: "entry:main", kind: "entry", name: "main" },
          {
            id: "module:spike/compiler-page-resources/probe.page-resource",
            kind: "module",
            name: "spike/compiler-page-resources/probe.page-resource",
          },
          {
            id: "page:detail.lynx.bundle",
            kind: "page",
            path: "detail.lynx.bundle",
          },
          {
            id: "page:main.lynx.bundle",
            kind: "page",
            path: "main.lynx.bundle",
          },
        ],
        schemaVersion: 1,
        source: "@rspack/core:chunkGraph",
      }),
    );
  }
};

describe("Lynx example compiler receipts", () => {
  it("fails when the compiler does not emit its page graph", async () => {
    const output = path.join(testRoot, "missing-graph");
    await writeCompilerOutput({ output, includeGraph: false });
    const { finishSpike } = await import(spikeAssetsPath);
    await expect(
      finishSpike(output, "react", "A", { resourceSet: "basic" }),
    ).rejects.toThrow("Compiler did not emit a Lynx page graph");
  });

  it("rejects a missing compiler page output", async () => {
    const output = path.join(testRoot, "missing-page");
    await writeCompilerOutput({ output });
    await fs.rm(path.join(output, "detail.lynx.bundle"));
    const { finishSpike } = await import(spikeAssetsPath);
    await expect(
      finishSpike(output, "react", "A", { resourceSet: "basic" }),
    ).rejects.toThrow("missing or unowned output");
  });

  it("rejects a graph from a compiler version outside the framework pin", async () => {
    const output = path.join(testRoot, "wrong-compiler-version");
    await writeCompilerOutput({ output });
    const graphPath = `${output}.page-graph.json`;
    const graph = JSON.parse(await fs.readFile(graphPath, "utf8"));
    graph.compilerVersion = "9.9.9";
    await fs.writeFile(graphPath, JSON.stringify(graph));
    const { finishSpike } = await import(spikeAssetsPath);
    await expect(
      finishSpike(output, "react", "A", { resourceSet: "basic" }),
    ).rejects.toThrow("unpinned Rspack version");
  });

  it("rejects an unowned file even when its path occurs in bundle bytes", async () => {
    const output = path.join(testRoot, "coincidental-path");
    await writeCompilerOutput({
      output,
      main: 'const coincidental = "orphan.js";',
      extraFiles: [["orphan.js", "orphan"]],
    });
    const { finishSpike } = await import(spikeAssetsPath);
    await expect(
      finishSpike(output, "react", "A", { resourceSet: "basic" }),
    ).rejects.toThrow("missing or unowned output");
  });

  it("uses the compiler graph when a dependency reference is transformed", async () => {
    const output = path.join(testRoot, "transformed-reference");
    await writeCompilerOutput({
      output,
      main: 'const encoded = "%61ssets%2Fprobe.png";',
    });
    const { finishSpike } = await import(spikeAssetsPath);
    await expect(
      finishSpike(output, "react", "A", { resourceSet: "basic" }),
    ).resolves.toMatchObject({
      pageEssentialResources: [
        {
          entry: "detail.lynx.bundle",
          resources: ["detail.lynx.bundle"],
        },
        {
          entry: "main.lynx.bundle",
          resources: ["assets/probe.png", "main.lynx.bundle"],
        },
      ],
      compilerGraph: {
        source: "@rspack/core:chunkGraph",
      },
    });
  });

  it("does not promote an emitted asset without a page dependency edge", async () => {
    const output = path.join(testRoot, "unused-emitted-asset");
    await writeCompilerOutput({ output });
    const graphPath = `${output}.page-graph.json`;
    const graph = JSON.parse(await fs.readFile(graphPath, "utf8"));
    graph.entries[1].resources = ["main.lynx.bundle"];
    graph.edges = graph.edges.filter(
      (edge: { from: string; kind: string }) =>
        !(edge.from === "page:main.lynx.bundle" && edge.kind === "requires"),
    );
    await fs.writeFile(graphPath, JSON.stringify(graph));
    const { finishSpike } = await import(spikeAssetsPath);
    await expect(
      finishSpike(output, "react", "A", { resourceSet: "basic" }),
    ).rejects.toThrow("missing or unowned output");
  });

  it("preserves a compiler dependency shared by both pages", async () => {
    const output = path.join(testRoot, "shared-dependency");
    await writeCompilerOutput({ output });
    const graphPath = `${output}.page-graph.json`;
    const graph = JSON.parse(await fs.readFile(graphPath, "utf8"));
    graph.entries[0].resources = ["assets/probe.png", "detail.lynx.bundle"];
    graph.edges.push({
      from: "chunk:detail",
      kind: "contains",
      to: "module:spike/compiler-page-resources/probe.page-resource",
    });
    graph.edges.push({
      from: "page:detail.lynx.bundle",
      kind: "requires",
      to: "asset:assets/probe.png",
    });
    graph.edges.sort(
      (left: Record<string, string>, right: Record<string, string>) => {
        const leftValue = JSON.stringify(left);
        const rightValue = JSON.stringify(right);
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      },
    );
    await fs.writeFile(graphPath, JSON.stringify(graph));
    const { finishSpike } = await import(spikeAssetsPath);
    await expect(
      finishSpike(output, "react", "A", { resourceSet: "basic" }),
    ).resolves.toMatchObject({
      pageEssentialResources: [
        {
          entry: "detail.lynx.bundle",
          resources: ["assets/probe.png", "detail.lynx.bundle"],
        },
        {
          entry: "main.lynx.bundle",
          resources: ["assets/probe.png", "main.lynx.bundle"],
        },
      ],
    });
  });

  it("rejects a receipt that omits a compiler-owned dependency", async () => {
    const output = path.join(testRoot, "tampered-receipt");
    await writeCompilerOutput({ output });
    const { finishSpike, readSpikePageContract } = await import(
      spikeAssetsPath
    );
    await finishSpike(output, "react", "A", { resourceSet: "basic" });
    const receiptPath = `${output}.build.json`;
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    receipt.pageEssentialResources[1].resources = ["main.lynx.bundle"];
    await fs.writeFile(receiptPath, JSON.stringify(receipt));
    await expect(readSpikePageContract(output)).rejects.toThrow(
      "invalid page dependency closure",
    );
  });
});

describe("atomic Lynx public example builds", () => {
  it("preserves the last successful output when the compiler fails", async () => {
    const outDir = path.join(testRoot, "published");
    const receiptPath = `${outDir}.build.json`;
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "previous.bundle"), "previous");
    await fs.writeFile(receiptPath, "previous receipt");
    const { buildPublic } = await import(buildPublicPath);

    await expect(
      buildPublic({
        framework: "octane",
        outDir,
        octaneSource: path.join(testRoot, "missing-octane-checkout"),
      }),
    ).rejects.toThrow();

    await expect(
      fs.readFile(path.join(outDir, "previous.bundle"), "utf8"),
    ).resolves.toBe("previous");
    await expect(fs.readFile(receiptPath, "utf8")).resolves.toBe(
      "previous receipt",
    );
    expect(
      (await fs.readdir(testRoot)).some((name) => name.includes(".build-")),
    ).toBe(false);
  });

  it("rejects an absolute destination outside the example build roots", async () => {
    const { buildPublic } = await import(buildPublicPath);
    await expect(
      buildPublic({
        framework: "react",
        outDir: path.join(path.dirname(exampleRoot), "escaped-build"),
      }),
    ).rejects.toThrow("inside this example's dist or .hot-updater build root");
  });
});

describe("Lynx native artifact targets", () => {
  it("keeps production, shipped E2E, and matrix products distinct", () => {
    const { HOT_UPDATER_APP_BASE_URL: _, ...baseEnvironment } = process.env;
    const readTarget = (target: string, appBaseURL?: string) => {
      const result = spawnSync(
        process.execPath,
        [
          nativeBuilderPath,
          "--platform",
          "all",
          "--target",
          target,
          "--dry-run",
        ],
        {
          cwd: path.resolve(exampleRoot, "../.."),
          encoding: "utf8",
          env: {
            ...baseEnvironment,
            ...(appBaseURL ? { HOT_UPDATER_APP_BASE_URL: appBaseURL } : {}),
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const marker = result.stdout
        .split("\n")
        .find((line) => line.startsWith("LYNX_NATIVE_ARTIFACTS="));
      expect(marker).toBeDefined();
      return JSON.parse(marker!.slice("LYNX_NATIVE_ARTIFACTS=".length));
    };

    expect(readTarget("scaffold")).toMatchObject({
      target: "scaffold",
      appId: "com.hotupdater.lynxexample",
      artifacts: {
        ios: { scheme: "SparklingGo" },
        android: { task: ":app:assembleRelease" },
      },
      productionConfiguration: { appBaseURLConfigured: false },
    });
    expect(readTarget("e2e")).toMatchObject({
      target: "e2e",
      appId: "com.hotupdater.lynxexample",
      artifacts: {
        ios: { scheme: "SparklingGoE2E" },
        android: { task: ":e2e-app:assembleRelease" },
      },
    });
    expect(readTarget("matrix")).toMatchObject({
      target: "matrix",
      appId: "com.hotupdater.lynxmatrix",
      artifacts: {
        ios: { scheme: "SparklingMatrixHarness" },
        android: { task: ":matrix-app:assembleRelease" },
      },
    });
    expect(
      readTarget("scaffold", "https://updates.company.com/hot-updater"),
    ).toMatchObject({
      productionConfiguration: { appBaseURLConfigured: true },
    });
  });
});

describe("production Lynx embedded bundles", () => {
  it.each(["ios", "android"])(
    "accepts only public page navigation in the %s scaffold",
    async (platform) => {
      const root = path.join(testRoot, "production-clean", platform);
      await fs.mkdir(root, { recursive: true });
      await Promise.all([
        fs.writeFile(
          path.join(root, "main.lynx.bundle"),
          productionMainFixture,
        ),
        fs.writeFile(
          path.join(root, "detail.lynx.bundle"),
          productionDetailFixture,
        ),
      ]);
      const { validateProductionEmbeddedBundles } = await import(
        productionEmbeddedContractPath
      );
      await expect(
        validateProductionEmbeddedBundles(root),
      ).resolves.toMatchObject({
        schemaVersion: "lynx-production-embedded-contract-v1",
        files: ["detail.lynx.bundle", "main.lynx.bundle"],
      });
    },
  );

  it.each([
    "http://localhost:3007",
    "/matrix-runtime-snapshot",
    "HOT_UPDATER_RUNTIME_SNAPSHOT",
    "Verify navigation boundary",
    "Capture runtime events",
    "targeted-qa-detox",
  ])("rejects production contamination %s", async (marker) => {
    const root = path.join(testRoot, "production-contaminated");
    await fs.mkdir(root, { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(root, "main.lynx.bundle"),
        `${productionMainFixture} ${marker}`,
      ),
      fs.writeFile(
        path.join(root, "detail.lynx.bundle"),
        productionDetailFixture,
      ),
    ]);
    const { validateProductionEmbeddedBundles } = await import(
      productionEmbeddedContractPath
    );
    await expect(validateProductionEmbeddedBundles(root)).rejects.toThrow(
      "contains test diagnostics",
    );
  });

  it.each(productionMainSdkCalls)(
    "rejects a production main bundle without %s",
    async (missingCall) => {
      const root = path.join(
        testRoot,
        "production-missing-sdk-call",
        String(productionMainSdkCalls.indexOf(missingCall)),
      );
      await fs.mkdir(root, { recursive: true });
      await Promise.all([
        fs.writeFile(
          path.join(root, "main.lynx.bundle"),
          productionMainFixture.replace(missingCall, ""),
        ),
        fs.writeFile(
          path.join(root, "detail.lynx.bundle"),
          productionDetailFixture,
        ),
      ]);
      const { validateProductionEmbeddedBundles } = await import(
        productionEmbeddedContractPath
      );
      await expect(validateProductionEmbeddedBundles(root)).rejects.toThrow(
        `missing Hot Updater SDK calls: ${missingCall}`,
      );
    },
  );

  it("rejects a production detail bundle without readiness", async () => {
    const root = path.join(testRoot, "production-detail-without-readiness");
    await fs.mkdir(root, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(root, "main.lynx.bundle"), productionMainFixture),
      fs.writeFile(
        path.join(root, "detail.lynx.bundle"),
        "sparkling-navigation router.close Close detail page",
      ),
    ]);
    const { validateProductionEmbeddedBundles } = await import(
      productionEmbeddedContractPath
    );
    await expect(validateProductionEmbeddedBundles(root)).rejects.toThrow(
      "missing Hot Updater SDK calls: .notifyAppReady()",
    );
  });
});

describe("production native update endpoint", () => {
  it("accepts an explicit public HTTPS application endpoint", () => {
    expect(
      resolveProductionAppBaseURL({
        HOT_UPDATER_APP_BASE_URL: "https://updates.company.com/hot-updater",
      }),
    ).toBe("https://updates.company.com/hot-updater");
  });

  it("keeps an unconfigured scaffold buildable", () => {
    expect(resolveProductionAppBaseURL({})).toBeNull();
  });

  it("confirms embedded readiness before reporting an absent endpoint", async () => {
    const source = await fs.readFile(productionSdkPath, "utf8");
    const readiness = source.indexOf("await HotUpdater.notifyAppReady()");
    const absentEndpoint = source.indexOf("if (!baseURL)");
    const configurationState = source.indexOf(
      "Production update endpoint is not configured in the native build.",
    );

    expect(readiness).toBeGreaterThan(-1);
    expect(absentEndpoint).toBeGreaterThan(readiness);
    expect(configurationState).toBeGreaterThan(-1);
  });

  it.each([
    "http://updates.company.com/hot-updater",
    "https://localhost/hot-updater",
    "https://127.0.0.2/hot-updater",
    "https://updates.test/hot-updater",
    "https://user:secret@updates.company.com/hot-updater",
    "https://updates.company.com/hot-updater#fragment",
    " https://updates.company.com/hot-updater",
  ])("rejects a nonproduction application endpoint %s", (appBaseURL) => {
    expect(() =>
      resolveProductionAppBaseURL({
        HOT_UPDATER_APP_BASE_URL: appBaseURL,
      }),
    ).toThrow("HOT_UPDATER_APP_BASE_URL");
  });

  it("reaches both production hosts through their native configuration", async () => {
    const [
      builder,
      androidHost,
      androidApp,
      androidE2eApp,
      androidMatrixApp,
      androidGradle,
      iosHost,
      iosPlist,
    ] = await Promise.all([
      fs.readFile(nativeBuilderPath, "utf8"),
      fs.readFile(
        path.join(
          exampleRoot,
          "../../packages/lynx/android-sparkling/src/main/java/com/hotupdater/lynx/sparkling/HotUpdaterSparklingHost.kt",
        ),
        "utf8",
      ),
      fs.readFile(
        path.join(
          exampleRoot,
          "android/app/src/main/java/com/hotupdater/lynxexample/OtaActivity.kt",
        ),
        "utf8",
      ),
      fs.readFile(
        path.join(
          exampleRoot,
          "android/e2e-app/src/main/java/com/hotupdater/lynxexample/OtaActivity.kt",
        ),
        "utf8",
      ),
      fs.readFile(
        path.join(
          exampleRoot,
          "android/matrix-app/src/main/java/com/hotupdater/lynxmatrix/MatrixActivity.kt",
        ),
        "utf8",
      ),
      fs.readFile(
        path.join(exampleRoot, "android/app/build.gradle.kts"),
        "utf8",
      ),
      fs.readFile(
        path.join(exampleRoot, "ios/SparklingGo/SparklingGo/PublicHost.swift"),
        "utf8",
      ),
      fs.readFile(path.join(exampleRoot, "ios/Info.plist"), "utf8"),
    ]);

    expect(builder).toContain(
      "`HOT_UPDATER_APP_BASE_URL=${productionAppBaseURL}`",
    );
    expect(builder).toContain(
      "`-PhotUpdaterAppBaseUrl=${productionAppBaseURL}`",
    );
    expect(androidHost).toContain(
      "val launchConfiguration: Map<String, String> = emptyMap()",
    );
    expect(androidHost).toContain(
      "val allowDiagnosticIntentLaunchConfiguration: Boolean = false",
    );
    expect(androidHost).toContain(
      "HotUpdaterSparklingLaunchConfiguration.resolve(",
    );
    expect(androidHost).toContain("configuration.launchConfiguration,");
    expect(androidHost).toContain(
      "configuration.allowDiagnosticIntentLaunchConfiguration,",
    );
    expect(androidGradle).toContain(
      'buildConfigField("String", "HOT_UPDATER_APP_BASE_URL"',
    );
    expect(androidApp).toContain('mapOf("appBaseURL" to it)');
    expect(androidApp).not.toContain(
      "allowDiagnosticIntentLaunchConfiguration",
    );
    expect(androidE2eApp).toContain(
      "allowDiagnosticIntentLaunchConfiguration = true",
    );
    expect(androidMatrixApp).toContain(
      "allowDiagnosticIntentLaunchConfiguration = true",
    );
    expect(iosPlist).toContain("$(HOT_UPDATER_APP_BASE_URL)");
    expect(iosHost).toContain('return ["appBaseURL": value]');
  });
});

describe("Lynx E2E runtime identity override", () => {
  it.each(["ios", "android"] as const)(
    "uses the embedded %s runtime identity by default",
    (platform) => {
      expect(resolveE2eBuildRuntimeId(platform, {})).toBe(
        lynxHostRuntimeId(platform),
      );
    },
  );

  it.each(["ios", "android"] as const)(
    "accepts only the deterministic %s cross-provenance identity",
    (platform) => {
      const hostRuntimeId = lynxHostRuntimeId(platform);
      expect(
        resolveE2eBuildRuntimeId(platform, {
          HOT_UPDATER_E2E_BUILD_MODE: "cross-provenance",
          HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE: `${hostRuntimeId}-cross-provenance-rejected`,
        }),
      ).toBe(`${hostRuntimeId}-cross-provenance-rejected`);
    },
  );

  it.each([
    {
      name: "an override outside cross-provenance mode",
      environment: {
        HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE: "arbitrary-runtime",
      },
    },
    {
      name: "cross-provenance mode without an override",
      environment: { HOT_UPDATER_E2E_BUILD_MODE: "cross-provenance" },
    },
    {
      name: "an empty override",
      environment: {
        HOT_UPDATER_E2E_BUILD_MODE: "cross-provenance",
        HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE: "",
      },
    },
    {
      name: "an arbitrary override in cross-provenance mode",
      environment: {
        HOT_UPDATER_E2E_BUILD_MODE: "cross-provenance",
        HOT_UPDATER_E2E_RUNTIME_ID_OVERRIDE: "wrong-runtime",
      },
    },
  ])("rejects $name before compilation", ({ environment }) => {
    expect(() => resolveE2eBuildRuntimeId("android", environment)).toThrow(
      "Cross-provenance E2E builds require",
    );
  });
});
