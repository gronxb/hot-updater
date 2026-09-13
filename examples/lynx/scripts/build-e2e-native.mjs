#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const {
  LYNX_E2E_BUILTIN_BUNDLE_ID,
  LYNX_E2E_SDK3_FILES,
  compileLynxE2eEmbedded,
  lynxE2eRuntimeId,
  materializeLynxNativeEmbedded,
  validateLynxEmbeddedDirectory,
} = await import("../../../e2e/lynx/embedded-bundle.ts");

const exampleDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
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
if (!platforms || !["matrix", "scaffold"].includes(values.target)) {
  throw new Error(
    "Usage: node scripts/build-e2e-native.mjs --platform <ios|android|all> --target <matrix|scaffold> [--dry-run]",
  );
}

const target = values.target;
const definitions = {
  matrix: {
    appId: "com.hotupdater.lynxmatrix",
    iosScheme: "SparklingMatrixHarness",
    androidModule: "matrix-app",
    receipt: "matrix-native-artifacts.json",
    derivedDataPath: "build/matrix",
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

async function prepareScaffoldEmbedded(platform) {
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
    if (target === "scaffold") await prepareScaffoldEmbedded(platform);
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
    run("sh", ["bootstrap.sh"], iosDir);
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
        "build",
      ],
      iosDir,
    );
    artifacts.ios = {
      path: artifactPath,
      scheme: definition.iosScheme,
      arch: iosSimulatorArch,
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
      "-PlynxE2eDebuggable=true",
      `-PhotUpdaterLynxAndroidAbis=${androidAbis.join(",")}`,
      ...(target === "scaffold"
        ? ["-PhotUpdaterLynxEmbeddedFrameworks=react"]
        : []),
    ],
    androidDir,
  );
  artifacts.android = { path: artifactPath, task, abis: androidAbis };
}

const receipt = {
  schemaVersion: "lynx-native-artifacts-v1",
  target,
  appId: definition.appId,
  artifacts,
};

if (!values["dry-run"]) {
  for (const [platform, artifact] of Object.entries(artifacts)) {
    if (!fs.existsSync(artifact.path)) {
      throw new Error(`Missing ${platform} build artifact: ${artifact.path}`);
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
