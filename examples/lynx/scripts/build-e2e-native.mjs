#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { resolveProductionAppBaseURL } from "./production-configuration.mjs";
import { validateProductionEmbeddedBundles } from "./production-embedded-contract.mjs";
import {
  androidArtifactAppId,
  assertTrackedSourceClean,
  deterministicArtifactSha256,
  iosArtifactAppId,
} from "./public-matrix/native-artifact-evidence.mjs";

const {
  LYNX_E2E_BUILTIN_BUNDLE_ID,
  LYNX_E2E_SDK3_FILES,
  compileLynxE2eEmbedded,
  lynxE2eRuntimeId,
  materializeLynxNativeEmbedded,
  validateLynxEmbeddedDirectory,
} = await import("../../../e2e/lynx/embedded-bundle.ts");
const { SPARKLING_NAVIGATION_PROVENANCE } =
  await import("../../../packages/lynx/src/navigationProvenance.ts");

const exampleDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoDir = path.resolve(exampleDir, "../..");
const cliArgs = process.argv.slice(2).filter((argument) => argument !== "--");
const { values } = parseArgs({
  args: cliArgs,
  options: {
    platform: { type: "string", default: "all" },
    target: { type: "string", default: "scaffold" },
    "dry-run": { type: "boolean" },
  },
  strict: true,
});
const platforms =
  values.platform === "all"
    ? ["ios", "android"]
    : values.platform === "ios" || values.platform === "android"
      ? [values.platform]
      : null;
if (!platforms || !["e2e", "matrix", "scaffold"].includes(values.target)) {
  throw new Error(
    "Usage: node scripts/build-e2e-native.mjs --platform <ios|android|all> --target <e2e|matrix|scaffold> [--dry-run]",
  );
}

const target = values.target;
const productionAppBaseURL =
  target === "scaffold" ? resolveProductionAppBaseURL() : null;
const definitions = {
  matrix: {
    appId: "com.hotupdater.lynxmatrix",
    iosScheme: "SparklingMatrixHarness",
    androidModule: "matrix-app",
    receipt: "matrix-native-artifacts.json",
    derivedDataPath: "build/matrix",
  },
  e2e: {
    appId: "com.hotupdater.lynxexample",
    iosScheme: "SparklingGoE2E",
    androidModule: "e2e-app",
    receipt: "e2e-native-artifacts.json",
    derivedDataPath: "build/e2e",
  },
  scaffold: {
    appId: "com.hotupdater.lynxexample",
    iosScheme: "SparklingGo",
    androidModule: "app",
    receipt: "scaffold-native-artifacts.json",
    derivedDataPath: "build",
  },
};
const definition = definitions[target];
const artifacts = {};
const embeddedContracts = {};
const protectedPreexistingPaths = [
  "examples-server/hono-kysely-pglite/hot-updater_migrations/migration_2026-09-11T14-30-47.sql",
  "examples-server/hono-kysely-pglite/src/db.ts",
  "examples-server/hono-kysely-pglite/src/localFsStorage.mjs",
  "examples-server/hono-kysely-pglite/src/localFsStorage.ts",
  "examples/lynx/.gitignore",
  "examples/lynx/scripts/e2e-kysely-deploy.mjs",
];
const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repoDir,
  encoding: "utf8",
}).stdout.trim();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error("Could not resolve the exact native source commit");
}
const sourceIntegrity = values["dry-run"]
  ? undefined
  : {
      checkedCommit: sourceCommit,
      ...assertTrackedSourceClean(repoDir, protectedPreexistingPaths),
    };
const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const fileSha256 = (file) => sha256(fs.readFileSync(file));
const productionDiagnosticMarkers = {
  ios: [
    "HotUpdaterLynxDiagnosticsContext",
    "installRuntimeJournalFixtureForDiagnostics",
  ],
  android: [
    "HotUpdaterLynxDiagnosticsModule",
    "HotUpdaterSparklingDiagnostics",
    "RuntimeJournalDiagnostics",
  ],
};

function scanProductionDiagnostics(platform, artifactPath, executable) {
  let bytes;
  if (platform === "ios") {
    bytes = fs.readFileSync(path.join(artifactPath, executable));
  } else {
    const result = spawnSync("unzip", ["-p", artifactPath, "classes*.dex"], {
      encoding: null,
      maxBuffer: 512 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error("Could not inspect the production Android bytecode");
    }
    bytes = result.stdout;
  }
  const present = productionDiagnosticMarkers[platform].filter((marker) =>
    bytes.includes(Buffer.from(marker)),
  );
  if (present.length) {
    throw new Error(
      `Production ${platform} artifact contains diagnostics: ${present.join(", ")}`,
    );
  }
  return {
    expected: "absent",
    markers: productionDiagnosticMarkers[platform],
    present,
  };
}

const configReceipt = (files) => {
  const entries = Object.fromEntries(
    files.map((relativePath) => [
      relativePath,
      fileSha256(path.join(repoDir, relativePath)),
    ]),
  );
  return {
    files: entries,
    sha256: sha256(
      Buffer.from(
        Object.entries(entries)
          .map(([file, hash]) => `${file}\0${hash}\n`)
          .join(""),
      ),
    ),
  };
};
const versions = {
  sparkling: "2.1.0-rc.12",
  lynx: "3.9.0",
  primjs: "3.8.0-alpha.6",
  hotUpdaterLynx: "1.0.0-rc.14",
};
const androidResolvedArtifacts = {
  "com.tiktok.sparkling:sparkling:2.1.0-rc.12@aar":
    "3f565f3a1e44ccc3c33d8a53e7ebd1af5e348e1aac3f4a8de83676e0080d64ea",
  "com.tiktok.sparkling:sparkling:2.1.0-rc.12@pom":
    "852ddb134a4f8534b648416594d8d4babb30ac43584e3423d4d1f8d3baf90880",
  "com.tiktok.sparkling:sparkling:2.1.0-rc.12@module":
    "7fd65ca2ef77deaa67102e3cfbf67a376ba95c35c5cdbc225e3ffd9cfa08b8c5",
  "com.tiktok.sparkling:sparkling-method:2.1.0-rc.12@aar":
    "2b5114e07640ff86ee43fc5ae0cd84cf98a53d2c40a19d432bf501496cc54b7a",
  "com.tiktok.sparkling:sparkling-method:2.1.0-rc.12@pom":
    "5d42601a13e3ffcf92fc973248e50b342ad78aa72fc297c051707fca8f207a06",
  "com.tiktok.sparkling:sparkling-method:2.1.0-rc.12@module":
    "01fd39296eddb16f3ab50ed5efd0880737d29d98900d1d7564e9e18637599e17",
};

function resolveAndroidSparklingArtifacts() {
  const cacheRoot = path.join(
    process.env.GRADLE_USER_HOME || path.join(os.homedir(), ".gradle"),
    "caches/modules-2/files-2.1/com.tiktok.sparkling",
  );
  return Object.fromEntries(
    Object.entries(androidResolvedArtifacts).map(([coordinate, expected]) => {
      const match =
        /com\.tiktok\.sparkling:([^:]+):([^@]+)@(aar|pom|module)$/.exec(
          coordinate,
        );
      if (!match) throw new Error(`Invalid Sparkling coordinate ${coordinate}`);
      const [, artifact, version, extension] = match;
      const versionRoot = path.join(cacheRoot, artifact, version);
      const filename = `${artifact}-${version}.${extension}`;
      const candidates = fs
        .readdirSync(versionRoot, { recursive: true })
        .filter((entry) => path.basename(String(entry)) === filename)
        .map((entry) => path.join(versionRoot, String(entry)));
      if (candidates.length !== 1) {
        throw new Error(
          `Expected one resolved ${coordinate}, found ${candidates.length}`,
        );
      }
      const observed = fileSha256(candidates[0]);
      if (observed !== expected) {
        throw new Error(`Resolved ${coordinate} checksum changed`);
      }
      return [coordinate, observed];
    }),
  );
}
const iosSimulatorArch =
  process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : null;
const androidAbis =
  process.arch === "arm64"
    ? ["arm64-v8a"]
    : process.arch === "x64"
      ? ["x86_64"]
      : null;

function run(command, args, cwd) {
  if (values["dry-run"]) return;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  }
}

async function prepareE2eEmbedded(platform) {
  const source = await compileLynxE2eEmbedded({
    exampleDir,
    platform,
    env: process.env,
  });
  const generated = await materializeLynxNativeEmbedded({
    exampleDir,
    platform,
    source,
  });
  const missing = generated.filter((file) => !fs.existsSync(file));
  if (missing.length) {
    throw new Error(
      `Native Lynx embedded generation missed: ${missing.join(", ")}`,
    );
  }
}

async function prepareProductionEmbedded(platform) {
  run(
    process.execPath,
    ["scripts/build-spike.mjs", "react", "A", "normal", "sdk3", "production"],
    exampleDir,
  );
  run(
    process.execPath,
    [
      "scripts/ota-embedded.mjs",
      "react",
      platform,
      "A-sdk3-managed",
      lynxE2eRuntimeId(platform),
      "production",
    ],
    exampleDir,
  );
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(
        exampleDir,
        `.hot-updater/ota/receipts/react-${platform}-A-sdk3-managed-production-embedded.json`,
      ),
      "utf8",
    ),
  );
  const embeddedRoot = path.join(exampleDir, ".hot-updater/ota/embedded");
  const relativeOutput = path.relative(embeddedRoot, receipt.outputPath ?? "");
  if (
    receipt.framework !== "react" ||
    receipt.platform !== platform ||
    receipt.fixture !== "A-sdk3-managed" ||
    receipt.profile !== "production" ||
    receipt.runtimeId !== lynxE2eRuntimeId(platform) ||
    receipt.embeddedBundleId !== LYNX_E2E_BUILTIN_BUNDLE_ID ||
    receipt.catalogMutation !== false ||
    !relativeOutput ||
    relativeOutput.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeOutput)
  ) {
    throw new Error(`Invalid production embedded receipt for ${platform}`);
  }
  const embedded = await validateLynxEmbeddedDirectory({
    root: receipt.outputPath,
    platform,
    expectedBundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
    expectedRuntimeId: lynxE2eRuntimeId(platform),
    expectedFiles: LYNX_E2E_SDK3_FILES,
  });
  const sourceContract = await validateProductionEmbeddedBundles(
    receipt.outputPath,
  );
  if (platform === "ios") {
    const root = path.join(exampleDir, "ios/ProductionEmbedded");
    const publicRoot = path.join(root, "Public");
    const destination = path.join(publicRoot, "react");
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(publicRoot, { recursive: true });
    fs.cpSync(receipt.outputPath, destination, { recursive: true });
    fs.writeFileSync(
      path.join(publicRoot, "react-native.json"),
      `${JSON.stringify({
        framework: "react",
        variant: "sdk3",
        runtimeId: embedded.runtimeId,
        bundleId: embedded.bundleId,
        minimumBundleId: embedded.bundleId,
        manifestDigest: embedded.manifestDigest,
        entry: embedded.entry,
        pageEntries: embedded.pageEntries,
        pageEssentialResources: embedded.pageEssentialResources,
      })}\n`,
    );
    return {
      source: sourceContract,
      materialized: await validateProductionEmbeddedBundles(destination),
    };
  }
  const root = path.join(
    exampleDir,
    "android/.hot-updater/production-embedded",
  );
  const destination = path.join(root, "ota/react/A");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(receipt.outputPath, destination, { recursive: true });
  return {
    source: sourceContract,
    materialized: await validateProductionEmbeddedBundles(destination),
  };
}

async function prepareMatrixEmbedded(platform) {
  for (const [index, framework] of ["react", "vue", "octane"].entries()) {
    const receiptPath = path.join(
      exampleDir,
      ".hot-updater/ota/receipts",
      `${framework}-${platform}-A-sdk3-managed-embedded.json`,
    );
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const sourceName = path.basename(receipt.outputPath ?? "");
    if (
      receipt.framework !== framework ||
      receipt.platform !== platform ||
      receipt.fixture !== "A-sdk3-managed" ||
      !sourceName.startsWith(`${framework}-${platform}-A-sdk3-managed-`)
    ) {
      throw new Error(
        `Invalid public embedded receipt for ${framework}/${platform}`,
      );
    }
    await materializeLynxNativeEmbedded({
      exampleDir,
      platform,
      source: path.join(exampleDir, ".hot-updater/ota/embedded", sourceName),
      framework,
      variant: "sdk3",
      resetPlatformRoot: index === 0,
    });
    const root =
      platform === "ios"
        ? path.join(exampleDir, "ios/Embedded/Public", framework)
        : path.join(
            exampleDir,
            "android/.hot-updater/embedded/ota",
            framework,
            "A",
          );
    let embedded;
    try {
      embedded = await validateLynxEmbeddedDirectory({
        root,
        platform,
        expectedBundleId: LYNX_E2E_BUILTIN_BUNDLE_ID,
        expectedRuntimeId: lynxE2eRuntimeId(platform),
        expectedFiles: LYNX_E2E_SDK3_FILES,
      });
    } catch (error) {
      throw new Error(
        `Missing or invalid ${platform} embedded A for ${framework}: ${error.message}`,
      );
    }
    if (platform === "ios") {
      const descriptorPath = path.join(
        exampleDir,
        "ios/Embedded/Public",
        `${framework}-native.json`,
      );
      const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
      if (
        descriptor.framework !== framework ||
        descriptor.bundleId !== embedded.bundleId ||
        descriptor.minimumBundleId !== embedded.bundleId ||
        descriptor.manifestDigest !== embedded.manifestDigest ||
        descriptor.runtimeId !== embedded.runtimeId ||
        descriptor.entry !== embedded.entry
      ) {
        throw new Error(`Invalid iOS embedded descriptor for ${framework}`);
      }
    }
  }
}

for (const platform of platforms) {
  if (!values["dry-run"]) {
    if (target === "scaffold") {
      embeddedContracts[platform] = await prepareProductionEmbedded(platform);
    } else if (target === "e2e") await prepareE2eEmbedded(platform);
    else await prepareMatrixEmbedded(platform);
  }
  if (platform === "ios") {
    if (!iosSimulatorArch) {
      throw new Error(
        `Unsupported macOS architecture for the iOS simulator build: ${process.arch}`,
      );
    }
    const iosDir = path.join(exampleDir, "ios");
    const derivedDataPath = definition.derivedDataPath;
    const artifactPath = path.join(
      iosDir,
      derivedDataPath,
      "Build/Products/Release-iphonesimulator",
      `${definition.iosScheme}.app`,
    );
    run("mise", ["exec", "--", "sh", "bootstrap.sh"], iosDir);
    run(
      "xcodebuild",
      [
        "-workspace",
        "SparklingGo.xcworkspace",
        "-scheme",
        definition.iosScheme,
        "-configuration",
        "Release",
        "-sdk",
        "iphonesimulator",
        "-derivedDataPath",
        derivedDataPath,
        "CODE_SIGNING_ALLOWED=NO",
        `ARCHS=${iosSimulatorArch}`,
        "ONLY_ACTIVE_ARCH=YES",
        ...(target === "scaffold" && productionAppBaseURL
          ? [`HOT_UPDATER_APP_BASE_URL=${productionAppBaseURL}`]
          : []),
        "build",
      ],
      iosDir,
    );
    artifacts.ios = {
      path: artifactPath,
      appId: definition.appId,
      scheme: definition.iosScheme,
      arch: iosSimulatorArch,
      runtimeId: lynxE2eRuntimeId("ios"),
      ...(target === "scaffold"
        ? { embeddedContract: embeddedContracts.ios }
        : {}),
    };
    continue;
  }
  const androidDir = path.join(exampleDir, "android");
  if (!androidAbis) {
    throw new Error(
      `Unsupported host architecture for Android: ${process.arch}`,
    );
  }
  const task = `:${definition.androidModule}:assembleRelease`;
  const artifactPath = path.join(
    androidDir,
    definition.androidModule,
    "build/outputs/apk/release",
    `${definition.androidModule}-release.apk`,
  );
  run(
    "./gradlew",
    [
      "--configure-on-demand",
      task,
      ...(target === "scaffold" ? [] : ["-PlynxE2eDebuggable=true"]),
      ...(target === "scaffold" && productionAppBaseURL
        ? [`-PhotUpdaterAppBaseUrl=${productionAppBaseURL}`]
        : []),
      `-PhotUpdaterLynxAndroidAbis=${androidAbis.join(",")}`,
    ],
    androidDir,
  );
  artifacts.android = {
    path: artifactPath,
    appId: definition.appId,
    task,
    abis: androidAbis,
    runtimeId: lynxE2eRuntimeId("android"),
    ...(target === "scaffold"
      ? { embeddedContract: embeddedContracts.android }
      : {}),
  };
}

const receipt = {
  schemaVersion: "lynx-native-artifacts-v2",
  target,
  appId: definition.appId,
  ...(target === "scaffold"
    ? {
        productionConfiguration: {
          appBaseURLConfigured: productionAppBaseURL !== null,
        },
      }
    : {}),
  sourceCommit,
  ...(sourceIntegrity ? { sourceIntegrity } : {}),
  versions,
  sparklingNavigation: SPARKLING_NAVIGATION_PROVENANCE,
  artifacts,
};

if (!values["dry-run"]) {
  for (const [platform, artifact] of Object.entries(artifacts)) {
    if (!fs.existsSync(artifact.path)) {
      throw new Error(`Missing ${platform} build artifact: ${artifact.path}`);
    }
    artifact.sourceCommit = sourceCommit;
    artifact.appId =
      platform === "ios"
        ? iosArtifactAppId(artifact.path)
        : androidArtifactAppId(artifact.path);
    if (artifact.appId !== definition.appId) {
      throw new Error(
        `${platform} artifact application ID ${artifact.appId} does not match ${definition.appId}`,
      );
    }
    artifact.binarySha256 = deterministicArtifactSha256(artifact.path);
    artifact.artifactHashKind =
      platform === "ios" ? "deterministic-full-app-tree-v1" : "full-apk-bytes";
    artifact.nativeFingerprintSha256 = JSON.parse(
      fs.readFileSync(path.join(exampleDir, "fingerprint.json"), "utf8"),
    )[platform].hash;
    if (target === "scaffold") {
      artifact.diagnostics = scanProductionDiagnostics(
        platform,
        artifact.path,
        definition.iosScheme,
      );
    }
    artifact.nativeConfig = configReceipt(
      platform === "ios"
        ? [
            "examples/lynx/fingerprint.json",
            "examples/lynx/ios/Podfile",
            "examples/lynx/ios/Podfile.lock",
            "examples/lynx/ios/SparklingGo.xcodeproj/project.pbxproj",
            `examples/lynx/ios/SparklingGo.xcodeproj/xcshareddata/xcschemes/${definition.iosScheme}.xcscheme`,
          ]
        : [
            "examples/lynx/fingerprint.json",
            "examples/lynx/android/settings.gradle.kts",
            "examples/lynx/android/gradle.properties",
            `examples/lynx/android/${definition.androidModule}/build.gradle.kts`,
            "packages/lynx/android/build.gradle",
            "packages/lynx/android-sparkling/build.gradle",
          ],
    );
    if (platform === "ios") {
      const checkout = path.join(exampleDir, "ios/.upstream/sparkling");
      const commit = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: checkout,
        encoding: "utf8",
      }).stdout.trim();
      const archive = spawnSync("git", ["archive", "--format=tar", "HEAD"], {
        cwd: checkout,
        encoding: null,
        maxBuffer: 256 * 1024 * 1024,
      });
      if (!/^[0-9a-f]{40}$/.test(commit) || archive.status !== 0) {
        throw new Error("Could not bind the resolved iOS Sparkling checkout");
      }
      artifact.sparklingCheckout = {
        path: "ios/.upstream/sparkling",
        commit,
        archiveSha256: sha256(archive.stdout),
      };
    } else {
      artifact.sparklingArtifacts = resolveAndroidSparklingArtifacts();
      artifact.sparklingDependencyGraphSha256 =
        "c68329c1968de962c8574f298ba46f43db016195bbbf4422b5e01145278aebe3";
    }
  }
  const receiptPath = path.join(
    exampleDir,
    ".hot-updater/public-matrix",
    definition.receipt,
  );
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  receipt.receiptPath = receiptPath;
}

console.log(`LYNX_NATIVE_ARTIFACTS=${JSON.stringify(receipt)}`);
